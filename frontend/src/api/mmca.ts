export type MmcaVenue = "seoul" | "gwacheon" | "deoksugung";

export interface MmcaRoomStatus {
  space_code: string;
  space_nm: string | null;
  congestion_nm: string | null;
  observed_at: string;
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
