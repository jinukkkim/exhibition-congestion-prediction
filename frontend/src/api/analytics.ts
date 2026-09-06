export interface VisitDay {
  date: string;
  views: number;
  visitors: number;
  bots: number;
}

export interface VisitReferrer {
  source: string;
  views: number;
}

export interface VisitStats {
  daily: VisitDay[];
  referrers: VisitReferrer[];
  devices: { mobile: number; desktop: number };
}

export async function fetchVisits(days: number): Promise<VisitStats> {
  const res = await fetch(`/analytics/visits?days=${days}`);
  if (!res.ok) {
    throw new Error(`failed to fetch visits: ${res.status}`);
  }
  return res.json();
}
