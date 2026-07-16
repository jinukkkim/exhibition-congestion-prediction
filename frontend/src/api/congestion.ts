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

export interface CongestionHistoryPoint {
  observed_at: string;
  population_avg: number;
}

export async function fetchHistory(hours: number): Promise<CongestionHistoryPoint[]> {
  const res = await fetch(`/congestion/history?hours=${hours}`);
  if (!res.ok) {
    throw new Error(`failed to fetch congestion history: ${res.status}`);
  }
  return res.json();
}
