from collections import defaultdict
from statistics import mean


def compute_baseline(rows) -> dict[tuple[int, int], float]:
    buckets: dict[tuple[int, int], list[float]] = defaultdict(list)
    for row in rows:
        key = (row.observed_at.weekday(), row.observed_at.hour)
        buckets[key].append(row.population_avg)
    return {key: mean(values) for key, values in buckets.items()}


def predict_baseline(baseline: dict[tuple[int, int], float], weekday: int, hour: int) -> float | None:
    return baseline.get((weekday, hour))
