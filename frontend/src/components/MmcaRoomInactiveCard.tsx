import type { MmcaRoomStatus } from "../api/mmca";

export function MmcaRoomInactiveCard({
  room,
  exhibitionTitle,
  reason,
}: {
  room: MmcaRoomStatus;
  exhibitionTitle: string | null;
  reason: string;
}) {
  const title = room.space_nm ?? room.space_code;

  return (
    <div className="relative overflow-hidden rounded-apple border border-hairline/60 bg-white/70 p-4 shadow-apple backdrop-blur-xl">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-soft">{title}</p>
      {/* 판독이 없는 방에도 전시는 걸려 있을 수 있다 — 혼잡도 API 가 전시가
          걸친 방 중 한 곳만 보고하기 때문이다. */}
      {exhibitionTitle && (
        <p className="mt-1 truncate text-[11px] text-ink-soft/80" title={exhibitionTitle}>
          {exhibitionTitle}
        </p>
      )}
      <p className="mt-2 text-sm font-semibold text-ink-soft">{reason}</p>
    </div>
  );
}
