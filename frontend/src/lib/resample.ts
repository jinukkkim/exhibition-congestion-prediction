// 두 관의 차트가 공유하는 마크 격자와 그 위로 판독을 모으는 평균.
//
// 마크는 자정 기준의 10분 배수다(10:00, 10:10, …). 두 관의 개관·폐관이 모두
// 10분 배수라 축의 양 끝도 마크이고, 그래서 호버·툴팁에 09:35·12:43 같은 시각이
// 아니라 10분 단위만 나온다. 개관 기준으로 끊으면 마크가 5분씩 밀린다.
//
// 국중박이 30분이던 이유는 그 차트가 2열 카드(480 단위 폭)였기 때문이다 — 그때
// 10분 간격은 22단위였다. 전폭이 된 뒤로는 같은 10분이 22px 라 점이 뭉치지 않는다.
//
// 이 값은 수집 간격과 **독립적이어야 한다.** 두 수집기의 격자는 서로 다르고
// (서울시 */5, MMCA */2) 지금까지 여러 번 바뀌었지만, 차트가 읽히는 밀도는
// 하루를 몇 점으로 그리느냐이지 판독을 몇 개 받았느냐가 아니다. 격자가 촘촘해질
// 때 늘어나야 하는 것은 점의 수가 아니라 마크 하나에 들어가는 표본 수다.
export const BUCKET_MINUTES = 10;

type Sample = { minutes: number; value: number };

/** 판독을 가장 가까운 마크로 모아 평균낸다.
 *
 * 마크 자체가 그 점의 시각이 된다 — 버킷의 시작도 중심도 아니다. 09:55·10:00 이
 * 10:00 에, 10:05·10:10 이 10:10 에 모인다.
 *
 * 평균이 하는 일은 점을 줄이는 것만이 아니다. MMCA 판독은 0~3 네 단계라 생값을
 * 그대로 그리면 네 층 사이를 오가는 계단이고, 그 위를 지나는 Catmull-Rom 은
 * 오버슈트할 수밖에 없다. 마크 평균은 소수를 만들어 곡선이 실제로 연속이 되게
 * 한다 — yOf 는 두 차트 모두 이미 소수를 받는다.
 *
 * `close` 로 자르는 이유: 폐관이 10분 배수인 동안에는 걸릴 일이 없지만(판독이
 * 폐관 이하이므로 마크도 그렇다), 영업시간이 09:45 처럼 바뀌면 마지막 마크가
 * 축을 넘고 svg 가 overflow-visible 이라 곡선이 축 밖 빈 자리로 이어져 그려진다.
 */
export function resample(points: Sample[], close: number, bucketMinutes: number): Sample[] {
  const marks = new Map<number, Sample[]>();
  for (const point of points) {
    const mark = Math.round(point.minutes / bucketMinutes) * bucketMinutes;
    const bucket = marks.get(mark);
    if (bucket) bucket.push(point);
    else marks.set(mark, [point]);
  }
  return [...marks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([mark, bucketPoints]) => ({
      minutes: mark,
      value: bucketPoints.reduce((sum, p) => sum + p.value, 0) / bucketPoints.length,
    }))
    .filter((p) => p.minutes <= close);
}
