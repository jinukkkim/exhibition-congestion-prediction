export type MmcaVenue = "seoul" | "gwacheon" | "deoksugung";

export interface MmcaRoomStatus {
  space_code: string;
  space_nm: string | null;
  congestion_nm: string | null;
  // null when there's no reading yet today — either a permanently-disabled
  // room with no collection history at all (see DISABLED_MMCA_SPACE_CODES),
  // or a normal room that just hasn't had its first poll of the day yet.
  observed_at: string | null;
}

export async function fetchMmcaRooms(venue: MmcaVenue): Promise<MmcaRoomStatus[]> {
  const res = await fetch(`/mmca/rooms?venue=${venue}`);
  if (!res.ok) {
    throw new Error(`failed to fetch MMCA rooms: ${res.status}`);
  }
  return res.json();
}

export interface MmcaDailyRoom {
  space_code: string;
  space_nm: string | null;
  congestion_nm: string | null;
}

export interface MmcaDailyLogPoint {
  observed_at: string;
  rooms: MmcaDailyRoom[];
}

export async function fetchMmcaDaily(venue: MmcaVenue, date: string): Promise<MmcaDailyLogPoint[]> {
  const res = await fetch(`/mmca/daily?venue=${venue}&date=${date}`);
  if (!res.ok) {
    throw new Error(`failed to fetch MMCA daily log: ${res.status}`);
  }
  return res.json();
}

export interface MmcaPredictionPoint {
  observed_at: string;
  // 0.0~3.0 의 소수. 평행이동과 90분 램프가 등급 사이 값을 만들고, 차트의
  // yOf 가 이미 소수를 받는다 — 반올림하면 정보가 줄어든다.
  tier: number;
  label: string;
}

export interface MmcaRoomPrediction {
  space_code: string;
  space_nm: string | null;
  anchored: boolean;
  points: MmcaPredictionPoint[];
}

// 이력이 모자란 방은 배열에서 아예 빠진다 — 없는 방은 에러가 아니라 "예측
// 없음"이다. 지나간 날짜는 빈 배열이 온다.
export async function fetchMmcaPrediction(
  venue: MmcaVenue,
  date: string
): Promise<MmcaRoomPrediction[]> {
  const res = await fetch(`/mmca/prediction?venue=${venue}&date=${date}`);
  if (!res.ok) {
    throw new Error(`failed to fetch MMCA prediction: ${res.status}`);
  }
  return res.json();
}

export interface MmcaExhibition {
  title: string;
  // YYYY-MM-DD
  start_date: string;
  end_date: string;
  // 이 전시가 쓰는 전시실. 서울박스·교육동처럼 혼잡도를 수집하지 않는 공간
  // 에서만 열리는 전시는 비어 있어 헤더 목록에만 실린다.
  space_codes: string[];
}

export async function fetchMmcaExhibitions(venue: MmcaVenue): Promise<MmcaExhibition[]> {
  const res = await fetch(`/mmca/exhibitions?venue=${venue}`);
  if (!res.ok) {
    throw new Error(`failed to fetch MMCA exhibitions: ${res.status}`);
  }
  return res.json();
}
