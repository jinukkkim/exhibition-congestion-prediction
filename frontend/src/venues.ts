export interface Venue {
  id: string;
  name: string;
  path: string;
}

export const VENUES: Venue[] = [
  { id: "national-museum", name: "국립중앙박물관", path: "/venues/national-museum" },
  { id: "mmca", name: "국립현대미술관", path: "/venues/mmca" },
];
