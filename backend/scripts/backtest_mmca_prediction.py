"""MMCA 예측의 롤링 오리진 백테스트.

app/prediction/mmca.py 의 네 상수(PROFILE_WINDOW_DAYS / ANCHOR_WINDOW_MINUTES
/ RAMP_MINUTES / 클램프 없음)의 근거를 만드는 스크립트다. 상수를 바꾸려면
먼저 이걸 돌려서 새 근거를 만들 것.

프로덕션 함수를 그대로 호출한다 — 로직을 재구현하면 근거가 갈라진다.

스펙 문서의 수치가 이 스크립트의 출력이어야 한다:
  docs/superpowers/specs/2026-08-26-mmca-prediction-chart-design.md

  python scripts/backtest_mmca_prediction.py [congestion.db]

CI 에 넣지 않는다 — git 에 없는 220MB 프로덕션 스냅샷에 의존한다. 실행 자체는
1.5초쯤이라 느려서가 아니다.

커버하지 않는 것: 스펙의 "오전 10-12시 고정" 행. 그건 `anchor_minutes` 로
표현할 수 없는 형태(고정 시각 창)이고 후보가 아니라 일회성 탐색이었다 —
일부러 뺐다. "오늘 전체" 는 `anchor=660` 으로 대신한다: 가장 긴 영업일보다
길어서 사실상 개장~현재 전체가 된다.
"""

import sqlite3
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.prediction.mmca import (  # noqa: E402
    ANCHOR_WINDOW_MINUTES,
    CONGESTION_RANKS,
    PROFILE_WINDOW_DAYS,
    RAMP_MINUTES,
    build_profile,
    predict_tier,
    today_shift,
)

HORIZONS = [10, 20, 30, 60, 90, 120]
TEST_LEN_DAYS = 5
# 스펙과 같은 창 시작점. 데이터 첫날로부터의 일수.
WINDOW_OFFSETS = (14, 17, 20, 23, 26)


@dataclass
class Reading:
    """build_profile / today_shift 가 기대하는 최소 인터페이스.

    ORM 인스턴스를 쓰지 않는 이유는 스크립트가 스냅샷 파일을 직접 열기
    때문이다 — 세 필드만 있으면 프로덕션 함수가 그대로 돈다.
    """

    space_code: str
    observed_at: datetime
    congestion_nm: str


def load(path: str) -> list[Reading]:
    con = sqlite3.connect(path)
    rows = con.execute(
        "select space_code, observed_at, congestion_nm from raw_mmca_congestion "
        "where congestion_nm is not null order by observed_at"
    ).fetchall()
    out: list[Reading] = []
    for code, raw, level in rows:
        if level not in CONGESTION_RANKS:
            continue
        # 초/마이크로초만 지운다. "정확히 h분 뒤" 조회(evaluate 의 `target not in
        # ranks`)가 성립하려면 스탬프가 그리드에 놓여 있어야 하는데, 그 정렬은
        # 이미 DB 안에서 끝나 있다 — collect_mmca_once 가 round_time 으로 찍고,
        # 그 이전 시대의 자유 주행 이력은 normalize_mmca_observed_at.py 가 15분
        # 마크로 옮겼다.
        #
        # 여기서 분까지 10분으로 내리던 줄을 지웠다. 수집 그리드가 10분일 때는
        # 항등이라 무해했지만 (a) 15분 마크의 옛 행을 어긋난 마크로 밀고
        # (b) MMCA_POLL_MINUTES 가 1 인 데이터에서는 같은 10분 마크에 몰린
        # 판독 10개가 evaluate 의 `ranks` dict 에서 마지막 하나만 남아 조용히
        # 버려진다 — 그 상태로도 `readings` 리스트는 10개를 그대로 돌기 때문에
        # 정확도 수치가 틀린 채로 나온다.
        stamp = datetime.fromisoformat(raw).replace(second=0, microsecond=0)
        out.append(Reading(code, stamp, level))
    return out


def evaluate(
    data: list[Reading],
    days: list[date],
    test_start: date,
    *,
    train_days: int = PROFILE_WINDOW_DAYS,
    anchor: int = ANCHOR_WINDOW_MINUTES,
    ramp: int = RAMP_MINUTES,
    use_shift: bool = True,
) -> tuple[int, int, float] | None:
    """한 테스트 창의 (n, 적중, 절대오차합). 데이터가 모자라면 None."""
    train = [r for r in data if test_start - timedelta(days=train_days) <= r.observed_at.date() < test_start]
    test_days = {d for d in days if test_start <= d < test_start + timedelta(days=TEST_LEN_DAYS)}
    if len(train) < 300 or not test_days:
        return None

    profile = build_profile(train)

    by_room_day: dict[tuple[str, date], list[Reading]] = defaultdict(list)
    for reading in data:
        if reading.observed_at.date() in test_days:
            by_room_day[(reading.space_code, reading.observed_at.date())].append(reading)

    n = hit = 0
    mae = 0.0
    for (code, day), readings in by_room_day.items():
        readings.sort(key=lambda r: r.observed_at)
        ranks = {r.observed_at: CONGESTION_RANKS[r.congestion_nm] for r in readings}
        for i, reading in enumerate(readings):
            now = reading.observed_at
            shifts = today_shift(profile, readings[: i + 1], now, anchor_minutes=anchor)
            if code not in shifts:
                # 앵커 관측이 모자라거나 프로파일 셀이 없다. 게이트는 두 변형에
                # 똑같이 걸어야 한다 — 표본이 다르면 보정 있음/없음 비교가
                # 근거가 아니라 인상이 된다.
                continue
            shift = shifts[code] if use_shift else 0.0
            current = ranks[now]
            for horizon in HORIZONS:
                target = now + timedelta(minutes=horizon)
                cell = profile.get((code, day.weekday(), target.hour))
                if target not in ranks or cell is None:
                    continue
                value = predict_tier(cell, shift, current, horizon, ramp_minutes=ramp)
                n += 1
                hit += max(0, min(3, round(value))) == ranks[target]
                mae += abs(value - ranks[target])
    return (n, hit, mae) if n else None


def sweep(data, days, starts, label: str, variants: list[tuple[str, dict]]) -> None:
    """변형별로 창마다의 정확도 + 합계를 찍는다.

    창별 수치를 찍는 이유: 롤링 오리진의 요점이 "어떤 결론도 한 창에 기대지
    않는다" 인데 여기 마진은 0.2~0.6%p 다. 합계만 찍으면 5창 중 2창에서만 이긴
    변형과 5창 전부에서 이긴 변형이 같아 보인다 — 근거의 강도가 사라진다.
    """
    print(f"\n{label}")
    columns = "".join(f"{f'창{k}':>7}" for k in range(1, len(starts) + 1))
    print(f"  {'변형':<14}{columns}{'합계':>9}{'MAE':>8}{'n':>9}")

    by_window: dict[str, list[float | None]] = {}
    for name, kwargs in variants:
        results = [evaluate(data, days, start, **kwargs) for start in starts]
        by_window[name] = [None if not r else r[1] / r[0] for r in results]
        got = [r for r in results if r]
        if not got:
            print(f"  {name:<14}{'측정 불가':>9}")
            continue
        n = sum(r[0] for r in got)
        cells = "".join(f"{'-':>7}" if a is None else f"{a:>7.1%}" for a in by_window[name])
        accuracy = sum(r[1] for r in got) / n
        print(f"  {name:<14}{cells}{accuracy:>9.1%}{sum(r[2] for r in got) / n:>8.2f}{n:>9}")

    # 동점이면 variants 순서상 앞선 쪽이 가져간다 — 마진이 0.1%p 미만인 창은
    # 어차피 근거로 쓸 수 없다.
    wins = Counter()
    for k in range(len(starts)):
        column = {name: a[k] for name, a in by_window.items() if a[k] is not None}
        if column:
            wins[max(column, key=lambda name: column[name])] += 1
    print("  창별 승리: " + ", ".join(f"{n} {c}/{len(starts)}" for n, c in wins.most_common()))


def main() -> None:
    path = sys.argv[1] if len(sys.argv) > 1 else "congestion.db"
    data = load(path)
    days = sorted({r.observed_at.date() for r in data})
    print(f"데이터: {len(data)}행 / {len(days)}일 / {days[0]} ~ {days[-1]}")
    starts = [days[0] + timedelta(days=k) for k in WINDOW_OFFSETS]

    sweep(data, days, starts, "① 앵커 창", [
        ("최근 60분", {"anchor": 60}),
        ("최근 120분", {"anchor": 120}),
        ("최근 240분", {"anchor": 240}),
        # "오늘 전체" 대신 660분 — 가장 긴 영업일보다 길어서 같은 값이 된다.
        ("오늘 전체", {"anchor": 660}),
    ])
    sweep(data, days, starts, "② 학습 창", [
        (f"{d}일", {"train_days": d}) for d in (7, 14, 21, 28)
    ])
    sweep(data, days, starts, "③ 램프 길이", [
        ("램프 없음", {"ramp": 0}),
        ("30분", {"ramp": 30}),
        ("90분", {"ramp": 90}),
        ("180분", {"ramp": 180}),
    ])
    sweep(data, days, starts, "④ 오늘 편차", [
        ("보정 없음", {"use_shift": False}),
        ("보정 있음", {"use_shift": True}),
    ])


if __name__ == "__main__":
    main()
