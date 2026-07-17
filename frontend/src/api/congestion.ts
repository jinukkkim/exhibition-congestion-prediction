export interface CurrentCongestion {
  observed_at: string;
  congest_level: string;
  population_avg: number;
}

export async function fetchCurrent(): Promise<CurrentCongestion> {
  const res = await fetch("/congestion/current");
  if (!res.ok) {
    throw new Error(`failed to fetch current congestion: ${res.status}`);
  }
  return res.json();
}

export interface PredictionCurvePoint {
  hour: number;
  baseline: number | null;
  model: number;
}

export interface PredictionResult {
  status: "collecting" | "ready";
  days_collected?: number;
  baseline_mae?: number;
  model_mae?: number;
  curve?: PredictionCurvePoint[];
}

export async function fetchPrediction(): Promise<PredictionResult> {
  const res = await fetch("/congestion/prediction");
  if (!res.ok) {
    throw new Error(`failed to fetch prediction: ${res.status}`);
  }
  return res.json();
}

export interface DailyLogPoint {
  observed_at: string;
  congest_level: string;
  population_min: number;
  population_max: number;
  male_ppltn_rate: number | null;
  female_ppltn_rate: number | null;
  ppltn_rate_0: number | null;
  ppltn_rate_10: number | null;
  ppltn_rate_20: number | null;
  ppltn_rate_30: number | null;
  ppltn_rate_40: number | null;
  ppltn_rate_50: number | null;
  ppltn_rate_60: number | null;
  ppltn_rate_70: number | null;
  resnt_ppltn_rate: number | null;
  non_resnt_ppltn_rate: number | null;
}

export async function fetchDaily(date: string): Promise<DailyLogPoint[]> {
  const res = await fetch(`/congestion/daily?date=${date}`);
  if (!res.ok) {
    throw new Error(`failed to fetch daily congestion log: ${res.status}`);
  }
  return res.json();
}
