import type { MmcaRoomStatus } from "../api/mmca";

export function MmcaRoomInactiveCard({ room, reason }: { room: MmcaRoomStatus; reason: string }) {
  const title = room.space_nm ?? room.space_code;

  return (
    <div className="relative overflow-hidden rounded-apple border border-hairline/60 bg-white/70 p-4 shadow-apple backdrop-blur-xl">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-soft">{title}</p>
      <p className="mt-2 text-sm font-semibold text-ink-soft">{reason}</p>
    </div>
  );
}
