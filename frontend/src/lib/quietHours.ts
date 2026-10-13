import type { WeeklyProfileCell } from "../api/congestion";

// /congestion/weekly-profile 의 weekday 번호 순서 그대로 — 0=월.
export const WEEKDAY_NAMES = ["월", "화", "수", "목", "금", "토", "일"];

/**
 * 정시 하나를 사람이 읽는 말로. 이 페이지가 다루는 값은 개관 시간 안의 정시
 * 뿐이라(백엔드 _full_hour_open) 10~20 만 들어온다 — 그래서 자정 언저리의
 * "오전 0시" 같은 어색한 경우는 만들지 않는다.
 */
export function hourLabel(hour: number): string {
  if (hour < 12) return `오전 ${hour}시`;
  if (hour === 12) return "낮 12시";
  return `오후 ${hour - 12}시`;
}

export interface Extremes {
  quietest: WeeklyProfileCell;
  busiest: WeeklyProfileCell;
}

/** 가장 한산한 칸과 가장 붐비는 칸. 히트맵의 색 범위도 이 둘이 정한다. */
export function extremes(cells: WeeklyProfileCell[]): Extremes | null {
  if (cells.length === 0) return null;
  let quietest = cells[0];
  let busiest = cells[0];
  for (const cell of cells) {
    if (cell.population_avg < quietest.population_avg) quietest = cell;
    if (cell.population_avg > busiest.population_avg) busiest = cell;
  }
  return { quietest, busiest };
}

/**
 * 이 페이지가 검색 결과에 내놓는 한 문장. 히트맵은 그림이라 크롤러가 읽지
 * 못하므로, 색인되는 것은 사실상 이 줄이다.
 *
 * "일대"라고 적는 이유는 값의 정체 때문이다 — 이 관의 혼잡도는 관람객 수가
 * 아니라 서울시 생활인구, 즉 그 지역에 있는 사람 수다. 관 안이 한산하다고
 * 말하면 데이터가 뒷받침하지 않는 말이 된다.
 *
 * 칸이 하나뿐이면(수집 첫날) 한산한 칸과 붐비는 칸이 같은 칸이라 문장이
 * 자기모순이 된다. 그때는 문장을 만들지 않는다.
 */
export function quietHoursHeadline(
  venueName: string,
  cells: WeeklyProfileCell[]
): string | null {
  const found = extremes(cells);
  if (found === null || found.quietest === found.busiest) return null;
  const { quietest, busiest } = found;
  return (
    `${venueName} 일대는 ` +
    `${WEEKDAY_NAMES[quietest.weekday]}요일 ${hourLabel(quietest.hour)}가 가장 한산하고, ` +
    `${WEEKDAY_NAMES[busiest.weekday]}요일 ${hourLabel(busiest.hour)}가 가장 붐빕니다.`
  );
}

/**
 * 값을 0~1 의 순위로 바꾸는 함수. 같은 값은 같은 자리다.
 *
 * 색을 최솟값~최댓값 사이의 위치로 칠하면 이 데이터에서는 농도가 거의 갈리지
 * 않는다. 낮 시간대 값이 2,200~2,900 에 몰려 있어 전체 폭의 뒤쪽 절반에
 * 40여 칸이 겹쳐 앉기 때문이다. 순위로 칠하면 그 40여 칸이 램프 전체에 고르게
 * 퍼져 옆 칸과 구별된다.
 *
 * 색이 뜻하는 것이 "몇 명"에서 "이 표에서 몇 번째"로 바뀌지만 순서는 그대로라
 * 더 붐비는 칸이 더 옅어지는 일은 없고, 실제 인원은 칸마다 숫자로 적혀 있다.
 */
export function rankScale(values: number[]): (value: number) => number {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const last = sorted.length - 1;
  const rank = new Map(sorted.map((value, index) => [value, last === 0 ? 0 : index / last]));
  return (value) => rank.get(value) ?? 0;
}

/**
 * 평균 등급(0.0~3.0)을 사람이 읽는 등급 이름으로.
 *
 * 반올림이라 "1.4 = 보통" 이다. 소수를 그대로 적으면 관람객에게 아무 뜻이 없고,
 * 이 사이트는 이미 네 등급의 이름으로 혼잡도를 말한다(lib/status.ts) — 같은
 * 말을 쓰는 편이 새 척도를 가르치는 것보다 낫다. 잃는 것은 칸 사이의 미세한
 * 차이인데, 그건 색이 아니라 아래 명세표가 감당할 몫이 아니다.
 */
export function rankLabel(rank: number, levels: string[]): string {
  return levels[Math.min(levels.length - 1, Math.max(0, Math.round(rank)))];
}

/**
 * MMCA 관 페이지의 한 문장. quietHoursHeadline 과 같은 자리에 서지만 값의
 * 정체가 달라 문구가 다르다 — 이쪽은 전시실 혼잡도라 "일대" 라는 헷지가 필요
 * 없다. 서울시 쪽은 생활인구여서 그 헷지를 달아야 했다.
 */
export function mmcaQuietHoursHeadline(
  venueName: string,
  cells: { weekday: number; hour: number; rank: number }[]
): string | null {
  if (cells.length === 0) return null;
  let quietest = cells[0];
  let busiest = cells[0];
  for (const cell of cells) {
    if (cell.rank < quietest.rank) quietest = cell;
    if (cell.rank > busiest.rank) busiest = cell;
  }
  if (quietest === busiest) return null;
  return (
    `${venueName}은 ` +
    `${WEEKDAY_NAMES[quietest.weekday]}요일 ${hourLabel(quietest.hour)}가 가장 한산하고, ` +
    `${WEEKDAY_NAMES[busiest.weekday]}요일 ${hourLabel(busiest.hour)}가 가장 붐빕니다.`
  );
}
