import type { MmcaRoomStatus } from "../api/mmca";
import { statusOf } from "../lib/status";

export function RoomCongestionCard({ room }: { room: MmcaRoomStatus }) {
  const status = statusOf(room.congestion_nm ?? "");

  return (
    <div className="rounded-apple border border-hairline/60 bg-white/70 p-6 shadow-apple backdrop-blur-xl">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-soft">
        {room.space_nm ?? room.space_code}
      </p>
      <p className="mt-2 text-2xl font-bold" style={{ color: status.text }}>
        {room.congestion_nm ?? "정보 없음"}
      </p>
      <p className="mt-1 text-[11px] text-ink-soft/70">
        마지막 갱신 {room.observed_at.slice(11, 16)}
      </p>
    </div>
  );
}
