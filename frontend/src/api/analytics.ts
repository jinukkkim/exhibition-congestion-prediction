export type UtmKey = "source" | "medium" | "campaign" | "content" | "term";

// 확정된 페이지 요청 한 줄. 집계 전의 행이라 화면이 필터마다 다시 센다.
export interface Pageview {
  at: string;
  path: string;
  // 주소와 UA 에서 만든 짧은 이름 — 같은 값이면 같은 방문자다.
  visitor: string;
  device: "mobile" | "tablet" | "desktop";
  browser: string;
  os: string;
  // null 은 우리 페이지에서 온 것(새로고침·뒤로가기)이다. 유입이 아니다.
  referrer: string | null;
  utm: Partial<Record<UtmKey, string>>;
}

export interface RecentVisit extends Pageview {
  // unconfirmed: HTML 만 받아 가고 앱은 뜨지 않은 요청. 대개 스캐너다.
  kind: "human" | "unconfirmed" | "bot";
}

export interface VisitStats {
  start: string;
  // pageviews 는 이 시각부터 실린다 — start 앞은 증감률을 세는 직전 기간이다.
  previous_start: string;
  // 로그가 남아 있는 가장 이른 시각. 직전 기간을 다 덮지 못하면 증감률을 그리지 않는다.
  coverage_start: string | null;
  pageviews: Pageview[];
  recent: RecentVisit[];
  excluded: { bots: number; unconfirmed: number };
}

export async function fetchVisits(days: number): Promise<VisitStats> {
  const res = await fetch(`/analytics/visits?days=${days}`);
  if (!res.ok) {
    throw new Error(`failed to fetch visits: ${res.status}`);
  }
  return res.json();
}
