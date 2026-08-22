import { monthDay, weekdayKo } from "../lib/date";

export function DateTabs({
  dates,
  selected,
  onSelect,
}: {
  dates: string[];
  selected: string;
  onSelect: (date: string) => void;
}) {
  return (
    <div role="tablist" className="flex flex-wrap gap-2">
      {dates.map((date, index) => {
        const isSelected = date === selected;
        return (
          <button
            key={date}
            type="button"
            role="tab"
            aria-selected={isSelected}
            onClick={() => onSelect(date)}
            className={`flex min-w-[64px] flex-col items-center gap-0.5 rounded-2xl px-4 py-2.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${
              isSelected
                ? "bg-ink text-white"
                : "text-ink-soft hover:bg-ink/5 hover:text-ink"
            }`}
          >
            {/* 혼잡도를 결정하는 것은 요일이고(모델 피처가 요일·시간·공휴일뿐)
                사람이 계획하는 것은 날짜이므로, 둘을 상하로 나눠 위계를 준다. */}
            <span className={`text-[11px] font-medium ${isSelected ? "text-white/70" : ""}`}>
              {index === 0 ? "오늘" : weekdayKo(date)}
            </span>
            <span
              className={`font-mono text-sm font-semibold tabular-nums ${
                isSelected ? "text-white" : "text-ink"
              }`}
            >
              {monthDay(date)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
