export interface Venue {
  id: string;
  name: string;
  path: string;
}

export const VENUES: Venue[] = [
  { id: "national-museum", name: "국립중앙박물관", path: "/venues/national-museum" },
  { id: "mmca", name: "국립현대미술관 서울관", path: "/venues/mmca" },
  { id: "mmca-gwacheon", name: "국립현대미술관 과천관", path: "/venues/mmca-gwacheon" },
  { id: "mmca-deoksugung", name: "국립현대미술관 덕수궁관", path: "/venues/mmca-deoksugung" },
];
