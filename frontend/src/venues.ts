import type { MmcaVenue } from "./api/mmca";

export interface Venue {
  id: string;
  name: string;
  path: string;
  // MMCA관이면 /mmca/rooms 파라미터. 없으면 국립중앙박물관
  // (/congestion/current) — 관 종류가 둘뿐이라 판별 유니온까지 갈 이유가 없다.
  mmcaVenue?: MmcaVenue;
}

export const VENUES: Venue[] = [
  { id: "national-museum", name: "국립중앙박물관", path: "/venues/national-museum" },
  {
    id: "mmca-seoul",
    name: "국립현대미술관 서울관",
    path: "/venues/mmca-seoul",
    mmcaVenue: "seoul",
  },
  {
    id: "mmca-gwacheon",
    name: "국립현대미술관 과천관",
    path: "/venues/mmca-gwacheon",
    mmcaVenue: "gwacheon",
  },
  {
    id: "mmca-deoksugung",
    name: "국립현대미술관 덕수궁관",
    path: "/venues/mmca-deoksugung",
    mmcaVenue: "deoksugung",
  },
];
