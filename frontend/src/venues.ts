import type { MmcaVenue } from "./api/mmca";

export interface Venue {
  id: string;
  name: string;
  path: string;
  // 이 관의 첫 판독이 저장된 날(YYYY-MM-DD). 로그 표의 "이전 날짜"가 여기서
  // 멈춘다 — 그 앞은 아무리 넘겨도 "데이터 없음"뿐이다. 수집을 시작한 날이
  // 관마다 달라 각 표가 따로 박아두면 어긋나므로 여기 한 곳에 모은다.
  earliestDate: string;
  // MMCA관이면 /mmca/rooms 파라미터. 없으면 국립중앙박물관
  // (/congestion/current) — 관 종류가 둘뿐이라 판별 유니온까지 갈 이유가 없다.
  mmcaVenue?: MmcaVenue;
}

// MMCA 수집기는 세 관을 한 번에 켰으므로 시작일이 같다.
const MMCA_EARLIEST_DATE = "2026-07-26";

export const VENUES: Venue[] = [
  {
    id: "national-museum",
    name: "국립중앙박물관",
    path: "/venues/national-museum",
    earliestDate: "2026-07-16",
  },
  {
    id: "mmca-seoul",
    name: "국립현대미술관 서울관",
    path: "/venues/mmca-seoul",
    earliestDate: MMCA_EARLIEST_DATE,
    mmcaVenue: "seoul",
  },
  {
    id: "mmca-gwacheon",
    name: "국립현대미술관 과천관",
    path: "/venues/mmca-gwacheon",
    earliestDate: MMCA_EARLIEST_DATE,
    mmcaVenue: "gwacheon",
  },
  {
    id: "mmca-deoksugung",
    // 덕수궁관은 수집 대상이 아니라 "첫 판독"이 없다. 그래도 필드는 비울 수
    // 없으므로 나머지 MMCA관과 같은 날을 쓴다: 수집이 켜졌다면 같은 수집기가
    // 같은 날 저장을 시작했을 날짜라 나중에 켜져도 고칠 일이 없고, 임의의 옛
    // 날짜를 넣어 없는 과거를 넘겨보게 두는 것보다 낫다.
    name: "국립현대미술관 덕수궁관",
    path: "/venues/mmca-deoksugung",
    earliestDate: MMCA_EARLIEST_DATE,
    mmcaVenue: "deoksugung",
  },
];
