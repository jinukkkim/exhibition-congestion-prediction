export interface VisitDay {
  date: string;
  views: number;
  visitors: number;
  // HTML 만 받아 가고 앱은 뜨지 않은 요청. 대개 스캐너다.
  unconfirmed: number;
  bots: number;
}

export interface Visit {
  at: string;
  path: string;
  kind: "human" | "unconfirmed" | "bot";
  // 주소가 아니라 주소에서 만든 짧은 이름 — 같은 값이면 같은 곳에서 왔다.
  visitor: string;
  device: "mobile" | "desktop";
  referrer: string | null;
}

export interface VisitReferrer {
  source: string;
  views: number;
}

export interface VisitStats {
  daily: VisitDay[];
  referrers: VisitReferrer[];
  devices: { mobile: number; desktop: number };
  visits: Visit[];
}

export async function fetchVisits(days: number): Promise<VisitStats> {
  const res = await fetch(`/analytics/visits?days=${days}`);
  if (!res.ok) {
    throw new Error(`failed to fetch visits: ${res.status}`);
  }
  return res.json();
}
