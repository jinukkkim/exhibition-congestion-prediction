export interface MmcaRoomStatus {
  space_code: string;
  space_nm: string | null;
  congestion_nm: string | null;
  observed_at: string;
}

export async function fetchMmcaRooms(): Promise<MmcaRoomStatus[]> {
  const res = await fetch("/mmca/rooms");
  if (!res.ok) {
    throw new Error(`failed to fetch MMCA rooms: ${res.status}`);
  }
  return res.json();
}
