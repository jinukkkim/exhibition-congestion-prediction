"""서울시(국립중앙박물관) 예측의 롤링 오리진 백테스트.

app/prediction/seoul.py 의 세 상수(PROFILE_WINDOW_DAYS / ANCHOR_WINDOW_MINUTES
/ RAMP_MINUTES)와 "덧셈 보정" 선택의 근거를 만드는 스크립트다. 상수를 바꾸려면
먼저 이걸 돌려서 새 근거를 만들 것. backtest_mmca_prediction.py 와 같은 형태다.

프로덕션 함수를 그대로 호출한다 — 로직을 재구현하면 근거가 갈라진다.

  python scripts/backtest_seoul_prediction.py [congestion.db]

CI 에 넣지 않는다 — git 에 없는 프로덕션 스냅샷에 의존한다.

평가 대상은 영업시간의 판독뿐이다. 차트가 그리는 구간이 거기고, 심야는 값이
낮고 평평해서 섞으면 영업시간 오차가 희석된다 — 지금 방식의 과대예측이 카드의
MAE 216 뒤에 숨어 있던 이유이기도 하다. 영업시간 게이트도 프로덕션
함수(seoul.in_business_hours)를 그대로 쓴다.
"""

import sqlite3
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from statistics import mean

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.prediction.seoul import (  # noqa: E402
    ANCHOR_WINDOW_MINUTES,
    PROFILE_WINDOW_DAYS,
    RAMP_MINUTES,
    build_profile,
    in_business_hours,
    predict_value,
    today_anchor,
)

# 차트가 "지금부터 폐관까지"를 그리므로 지평도 그 폭이다.
HORIZONS = [30, 60, 120, 180, 240, 360]
TEST_LEN_DAYS = 5
WINDOW_OFFSETS = (28, 32, 36, 40, 44)
# 앵커를 다시 잡는 간격. 5분마다 재는 것과 결론이 같고 25배 빠르다.
STEP_MINUTES = 30

@dataclass
class Reading:
    """build_profile / today_anchor 가 기대하는 최소 인터페이스."""

    observed_at: datetime
    population_avg: float


def load(path: str) -> list[Reading]:
    con = sqlite3.connect(path)
    rows = con.execute(
        "select observed_at, (population_min + population_max) / 2.0 from raw_congestion "
        "where population_min is not null order by observed_at"
    ).fetchall()
    return [Reading(datetime.fromisoformat(raw), value) for raw, value in rows]


def evaluate(
    data: list[Reading],
    test_start: date,
    *,
    train_days: int = PROFILE_WINDOW_DAYS,
    anchor: int = ANCHOR_WINDOW_MINUTES,
    ramp: int = RAMP_MINUTES,
    use_anchor: bool = True,
    ratio: bool = True,
    method: str = "profile",
) -> tuple[int, float, float] | None:
    """한 테스트 창의 (n, 절대오차합, 부호오차합). 데이터가 모자라면 None.

    `method="baseline_all"` 은 전 기간 (요일, 시각) 평균이다 — 창·앵커·램프와
    무관하지만 표본 게이트는 똑같이 걸린다.
    """
    test_days = [test_start + timedelta(days=k) for k in range(TEST_LEN_DAYS)]
    window_start = test_start - timedelta(days=train_days)
    train = [r for r in data if window_start <= r.observed_at.date() < test_start]
    history = [r for r in data if r.observed_at.date() < test_start]
    if len(train) < 500:
        return None

    profile = build_profile(train)
    if method == "baseline_all":
        # 창을 자르지 않은 프로파일이 곧 "전 기간 (요일, 시각) 평균"이다 —
        # 대조군에도 프로덕션 함수를 그대로 쓴다.
        all_profile = build_profile(history)
        fallback = mean(r.population_avg for r in history)

    n = 0
    absolute = 0.0
    signed = 0.0
    for day in test_days:
        readings = [r for r in data if r.observed_at.date() == day and in_business_hours(r.observed_at)]
        if not readings:
            continue
        actual = {r.observed_at: r.population_avg for r in readings}
        step = max(1, STEP_MINUTES // 5)
        for i in range(0, len(readings), step):
            now = readings[i].observed_at
            # 게이트는 모든 변형에 똑같이 걸어야 한다 — 표본이 다르면 보정
            # 있음/없음 비교가 근거가 아니라 인상이 된다.
            found = today_anchor(profile, readings[: i + 1], now, anchor_minutes=anchor)
            if found is None:
                continue
            for horizon in HORIZONS:
                target = now + timedelta(minutes=horizon)
                if target not in actual or not in_business_hours(target):
                    continue
                cell = profile.get((day.weekday(), target.hour))
                if cell is None:
                    continue
                if method == "baseline_all":
                    value = all_profile.get((target.weekday(), target.hour), fallback)
                else:
                    value = predict_value(
                        cell,
                        found if use_anchor else None,
                        readings[i].population_avg,
                        horizon,
                        ramp_minutes=ramp,
                        ratio=ratio,
                    )
                n += 1
                absolute += abs(value - actual[target])
                signed += value - actual[target]
    return (n, absolute, signed) if n else None


def sweep(data, starts, label: str, variants: list[tuple[str, dict]]) -> None:
    """변형별로 창마다의 MAE + 합계를 찍는다.

    창별 수치를 찍는 이유는 MMCA 쪽과 같다: 롤링 오리진의 요점이 "어떤 결론도
    한 창에 기대지 않는다" 는 것이라, 합계만 찍으면 5창 중 2창에서만 이긴 변형과
    5창 전부에서 이긴 변형이 같아 보인다.
    """
    print(f"\n{label}")
    columns = "".join(f"{f'창{k}':>7}" for k in range(1, len(starts) + 1))
    print(f"  {'변형':<14}{columns}{'MAE':>8}{'편향':>8}{'n':>8}")

    by_window: dict[str, list[float | None]] = {}
    for name, kwargs in variants:
        results = [evaluate(data, start, **kwargs) for start in starts]
        by_window[name] = [None if not r else r[1] / r[0] for r in results]
        got = [r for r in results if r]
        if not got:
            print(f"  {name:<14}{'측정 불가':>9}")
            continue
        n = sum(r[0] for r in got)
        cells = "".join(f"{'-':>7}" if a is None else f"{a:>7.0f}" for a in by_window[name])
        print(
            f"  {name:<14}{cells}{sum(r[1] for r in got) / n:>8.0f}"
            f"{sum(r[2] for r in got) / n:>+8.0f}{n:>8}"
        )

    wins = Counter()
    for k in range(len(starts)):
        column = {name: a[k] for name, a in by_window.items() if a[k] is not None}
        if column:
            wins[min(column, key=lambda name: column[name])] += 1
    print("  창별 승리: " + ", ".join(f"{n} {c}/{len(starts)}" for n, c in wins.most_common()))


def main() -> None:
    path = sys.argv[1] if len(sys.argv) > 1 else "congestion.db"
    data = load(path)
    days = sorted({r.observed_at.date() for r in data})
    print(f"데이터: {len(data)}행 / {len(days)}일 / {days[0]} ~ {days[-1]}")
    print(f"평가: 영업시간 판독, 지평 {HORIZONS}분, 창당 {TEST_LEN_DAYS}일")
    starts = [days[0] + timedelta(days=k) for k in WINDOW_OFFSETS]

    # 각 스윕은 나머지 축을 seoul.py 의 기본값에 고정한다. ①②가 먼저인 이유는
    # 그 둘이 다른 축의 조건을 정하기 때문이다 — 보정 방식을 덧셈으로 둔 채 창을
    # 재면 이기는 창이 달라진다.
    # 걷어낸 GBR(전 기간 학습, 피처 = 요일·시각·공휴일)은 이 하니스에서 MAE 314
    # / 편향 +151 이었다(2026-09-03 스냅샷). 그 행을 남기려면 scikit-learn 을
    # 의존성에 붙들고 있어야 해서 뺐다 — 전체평균이 328 이라 두 방식이 사실상
    # 같은 자리였고, 이 스윕의 요점("이전 방식 대비 얼마나 나아졌나")은 그 행
    # 하나로 충분하다.
    sweep(data, starts, "① 방식", [
        ("전체평균", {"method": "baseline_all"}),
        ("프로파일만", {"use_anchor": False}),
        ("프로파일+앵커", {}),
    ])
    sweep(data, starts, "② 오늘 보정", [
        ("보정 없음", {"use_anchor": False}),
        ("덧셈", {"ratio": False}),
        ("비율", {"ratio": True}),
    ])
    # 7일 미만은 뺀다 — (요일, 시각) 키라 창이 7일보다 짧으면 못 채우는 요일이
    # 생기고, 그 셀이 통째로 빠져 표본(n)이 달라진다. 그러면 창 길이 비교가
    # 근거가 아니라 인상이 된다. 7의 배수가 아닌 길이도 요일마다 표본 수가
    # 달라지므로 후보로 두지 않는다.
    sweep(data, starts, "③ 학습 창", [
        (f"{d}일", {"train_days": d}) for d in (7, 14, 21, 28)
    ])
    # 이 스윕만 변형마다 게이트가 자기 창을 쓴다(앵커가 곧 게이트라 피할 수 없다).
    # n 이 어긋나면 그 행은 비교에서 빼고 읽을 것.
    sweep(data, starts, "④ 앵커 창", [
        (f"최근 {m}분", {"anchor": m}) for m in (30, 60, 120, 240, 690)
    ])
    sweep(data, starts, "⑤ 램프 길이", [
        ("램프 없음", {"ramp": 0}),
        ("30분", {"ramp": 30}),
        ("90분", {"ramp": 90}),
        ("180분", {"ramp": 180}),
        ("360분", {"ramp": 360}),
    ])


if __name__ == "__main__":
    main()
