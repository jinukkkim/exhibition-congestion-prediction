import { shiftDate } from "./date";

export interface ComparisonDay<T> {
  date: string;
  points: T[];
}

/**
 * 차트의 회색 비교선에 쓸 하루. 기본은 지난주 같은 요일(D−7)이고, 그날 기록이
 * 하나도 없으면 D−14 로 물러선다.
 *
 * 물러설 일이 실제로 생기는 곳은 MMCA 다. 정기 휴관 요일이 아닌 날 문을 닫으면
 * (대체 휴관, 임시 휴관) 수집 게이트가 그날을 아예 수집하지 않아 하루가 통째로
 * 비고, 그 이레 뒤 화면에는 비교할 선이 없다. 한 주 더 뒤로 가면 같은 요일의
 * 온전한 하루가 있다.
 *
 * 휴관일 달력을 보지 않고 "기록이 비었는가" 로 판단하는 이유는 그것이 실제로
 * 묻는 질문이어서다 — 그릴 선이 있는가. 수집 장애로 빈 하루도 같은 처리를
 * 받는다. 국립중앙박물관은 생활인구를 24시간 모으므로 휴관일에도 하루가 차 있어
 * 이 갈래에 들어오지 않는다.
 *
 * D−14 마저 비면 빈 목록을 그대로 돌려준다. 비교선이 없는 화면은 이미 있는
 * 상태이고(수집 첫 주), 더 물러서 봐야 비교 대상으로서 뜻이 옅어진다.
 */
export async function fetchComparisonDay<T>(
  today: string,
  fetchDay: (date: string) => Promise<T[]>
): Promise<ComparisonDay<T>> {
  const lastWeek = shiftDate(today, -7);
  const points = await fetchDay(lastWeek);
  if (points.length > 0) return { date: lastWeek, points };

  const twoWeeksAgo = shiftDate(today, -14);
  return { date: twoWeeksAgo, points: await fetchDay(twoWeeksAgo) };
}
