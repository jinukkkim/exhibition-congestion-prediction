import type { MmcaPredictionPoint, MmcaRoomPrediction, MmcaRoomStatus } from "../api/mmca";
import { STATUS_LEVELS } from "./status";

// 관 전체 혼잡도 = 그 시각에 판독이 있는 전시실들의 등급 평균.
//
// 이 규칙은 새로 고른 것이 아니다 — 백엔드 주간 프로파일이 이미 같은 평균으로
// 관 단위 칸을 만들고(routes/mmca.py 의 venue_cells), `/venues/*/when` 이 그것을
// 헤드라인으로 띄운다. 여기서 하는 일은 같은 규칙을 실시간 쪽에 맞추는 것뿐이라
// 두 화면이 서로 다른 뜻의 "관 전체"를 말하지 않는다.
//
// 최댓값(가장 붐비는 방)이 아니라 평균인 이유는 데이터에 있다. 7/26~9/14 판독
// 으로 재면 최댓값은 서울관에서 67%의 시간이 "붐빔"이라 사실상 고정값이고,
// 평균은 여유 19% · 보통 37% · 약간 붐빔 28% · 붐빔 16% 로 실제로 움직인다.
// 대신 평균은 붐비는 방 하나를 가린다 — 붐빔인 방이 있는데 평균이 여유/보통인
// 시간이 서울관 24.8%(과천관 1.2%)다. 그 방은 관 페이지의 전시실 카드가 그대로
// 말하므로, 한눈에 읽히는 값 쪽을 택했다.

// 등급 → 0~3. STATUS_LEVELS 는 혼잡도 낮은 순이라 인덱스가 곧 등급이다
// (lib/status.ts). 백엔드 prediction/mmca.py 의 RANK_LABELS 와 같은 순서여야
// 한다.
export function tierOf(level: string | null | undefined): number | null {
  if (level == null) return null;
  const tier = STATUS_LEVELS.indexOf(level);
  return tier === -1 ? null : tier;
}

export function labelOf(tier: number): string {
  return STATUS_LEVELS[Math.round(tier)];
}

// 판독이 있는 방들의 평균 등급(0~3 소수). 읽을 방이 하나도 없으면 null.
//
// 방마다 가중치가 같다 — 전시실 면적도 수용 인원도 API 가 주지 않으므로 가중할
// 근거가 없다. 방 구성이 도중에 바뀌면(resultCode 0002 로 빠지는 방) 평균이 그만큼
// 흔들리지만, 실측으로 재면 연속 판독 사이 방 구성이 바뀌는 비율이 2.8~4.4%이고
// 관 평균 라벨이 바뀌는 경우의 91~93%는 방 구성이 그대로인 채 등급이 실제로 바뀐
// 것이라 곡선을 흔드는 요인이 되지 못한다.
export function venueTier(rooms: { congestion_nm: string | null }[]): number | null {
  const tiers = rooms.map((room) => tierOf(room.congestion_nm)).filter((t): t is number => t !== null);
  if (tiers.length === 0) return null;
  return tiers.reduce((sum, t) => sum + t, 0) / tiers.length;
}

// 방별 예측을 시각별로 평균내 관 하나의 예측으로 접는다. 방마다 점 격자가
// 같으므로(배치가 한 번에 만든다) 시각을 키로 모으면 그대로 맞물린다.
//
// 이력이 모자란 방은 응답에서 아예 빠진다 — 그 방들은 평균에서도 빠지므로 관
// 예측은 "예측이 있는 방들의 평균"이다. 실선(전체 방 평균)과 모수가 달라질 수
// 있지만, 없는 예측을 지어내는 것보다는 낫다.
//
// anchored 는 방 전체가 오늘 판독에 고정됐을 때만 참으로 둔다. 하나라도 고정되지
// 않았으면 범례의 "예측 (오늘 반영)"이 관 전체에 대해서는 과장이 된다.
export function venuePrediction(predictions: MmcaRoomPrediction[]): MmcaRoomPrediction | null {
  if (predictions.length === 0) return null;

  const byTime = new Map<string, number[]>();
  for (const room of predictions) {
    for (const point of room.points) {
      const tiers = byTime.get(point.observed_at);
      if (tiers) tiers.push(point.tier);
      else byTime.set(point.observed_at, [point.tier]);
    }
  }
  if (byTime.size === 0) return null;

  const points: MmcaPredictionPoint[] = [...byTime.entries()]
    // ISO 문자열은 같은 포맷이면 사전순 = 시간순.
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([observed_at, tiers]) => {
      const tier = tiers.reduce((sum, t) => sum + t, 0) / tiers.length;
      return { observed_at, tier, label: labelOf(tier) };
    });

  return {
    space_code: VENUE_SPACE_CODE,
    space_nm: VENUE_TITLE,
    anchored: predictions.every((room) => room.anchored),
    points,
  };
}

// 관 전체 카드는 전폭이라 국립중앙박물관 CongestionCard 와 같은 좌표계를 쓴다
// (그쪽 SPARKLINE_WIDTH/HEIGHT). 방 카드(480x200)를 그대로 늘리면 선과 글자가
// 2.5배로 부푼다.
export const VENUE_CHART_WIDTH = 1120;
export const VENUE_CHART_HEIGHT = 320;

// 판독이 있는 방 중 가장 최근 시각. ISO 문자열은 같은 포맷이면 사전순 = 시간순.
export function latestObservedAt(rooms: { observed_at: string | null }[]): string | null {
  return rooms.reduce<string | null>(
    (latest, room) =>
      room.observed_at !== null && (latest === null || room.observed_at > latest)
        ? room.observed_at
        : latest,
    null
  );
}

// 관 전체를 전시실 하나인 척 접은 상태. 차트 카드가 제목·현재 등급·신선도 점을
// 이 값으로 그대로 그리므로 카드 쪽에 관 전용 분기를 두지 않아도 된다.
export function venueRoomStatus(rooms: MmcaRoomStatus[] | null): MmcaRoomStatus {
  const read = rooms ?? [];
  const tier = venueTier(read);
  return {
    space_code: VENUE_SPACE_CODE,
    space_nm: VENUE_TITLE,
    congestion_nm: tier === null ? null : labelOf(tier),
    // 판독이 있는 방만 센다 — 값 없이 시각만 실려 온 방이 "기준" 시각을
    // 끌어올리면 현재 등급보다 새 시각이 적힌다.
    observed_at: latestObservedAt(read.filter((room) => room.congestion_nm !== null)),
  };
}

// 합성 전시실의 코드. 실제 MMCA-SPACE-* 와 겹치지 않아야 한다 — 차트 카드가 이
// 값으로 SVG 그라디언트 id 를 만들기 때문에 같은 페이지의 방 카드와 부딪히면
// 채움색이 서로 섞인다.
export const VENUE_SPACE_CODE = "venue-total";
export const VENUE_TITLE = "관 전체";
