import { monthDay, weekdayKo } from "../lib/date";

// 탭에서는 요일이 먼저 읽히는 편이 고르기 쉬워 "월 8/24" 순서로 쓴다.
function tabLabel(date: string, isFirst: boolean): string {
  return isFirst ? `오늘 (${weekdayKo(date)})` : `${weekdayKo(date)} ${monthDay(date)}`;
}

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
    <div role="tablist" className="flex flex-wrap gap-1.5">
      {dates.map((date, index) => {
        const isSelected = date === selected;
        return (
          <button
            key={date}
            type="button"
            role="tab"
            aria-selected={isSelected}
            onClick={() => onSelect(date)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${
              isSelected ? "bg-ink text-white" : "text-ink-soft hover:bg-ink/5 hover:text-ink"
            }`}
          >
            {tabLabel(date, index === 0)}
          </button>
        );
      })}
    </div>
  );
}
