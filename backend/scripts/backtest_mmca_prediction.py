"""MMCA 예측의 롤링 오리진 백테스트.

app/prediction/mmca.py 의 네 상수(PROFILE_WINDOW_DAYS / ANCHOR_WINDOW_MINUTES
/ RAMP_MINUTES / 클램프 없음)의 근거를 만드는 스크립트다. 상수를 바꾸려면
먼저 이걸 돌려서 새 근거를 만들 것.

프로덕션 함수를 그대로 호출한다 — 로직을 재구현하면 근거가 갈라진다.

스펙 문서의 수치가 이 스크립트의 출력이어야 한다:
  docs/superpowers/specs/2026-08-26-mmca-prediction-chart-design.md

  python scripts/backtest_mmca_prediction.py [congestion.db]

CI 에 넣지 않는다 — 프로덕션 스냅샷이 필요하고 실행이 길다.
"""

import sqlite3
import sys
from collections import defaultdict
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
        stamp = datetime.fromisoformat(raw).replace(second=0, microsecond=0)
        # 수집은 10분 그리드에 정렬돼 있다(scheduler.py). 초/마이크로초 편차를
        # 지워야 "정확히 h분 뒤" 조회가 성립한다.
        out.append(Reading(code, stamp.replace(minute=stamp.minute // 10 * 10), level))
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
            shift = 0.0
            if use_shift:
                shifts = today_shift(profile, readings[: i + 1], now, anchor_minutes=anchor)
                if code not in shifts:
                    # 앵커 관측이 모자라거나 프로파일 셀이 없다 — 스킵해서
                    # 변형끼리 같은 표본을 비교하게 한다.
                    continue
                shift = shifts[code]
            elif not any(
                (code, day.weekday(), r.observed_at.hour) in profile
                for r in readings[: i + 1]
            ):
                continue
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
    print(f"\n{label}")
    print(f"  {'변형':<14}{'정확도':>10}{'MAE':>8}{'n':>9}")
    for name, kwargs in variants:
        total = [0, 0, 0.0]
        for start in starts:
            got = evaluate(data, days, start, **kwargs)
            if not got:
                continue
            total[0] += got[0]
            total[1] += got[1]
            total[2] += got[2]
        if not total[0]:
            print(f"  {name:<14}{'측정 불가':>10}")
            continue
        print(f"  {name:<14}{total[1] / total[0]:>9.1%}{total[2] / total[0]:>8.2f}{total[0]:>9}")


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
        # "오늘 전체" 는 아주 큰 창으로 흉내낸다 — 영업시간이 최대 11시간이다.
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
