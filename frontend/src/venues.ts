import type { MmcaVenue } from "./api/mmca";

// 관 이름 아래 헤더에 실리는 관 단위 정보. 몇 년에 한 번 바뀔 값이라 API 를
// 두지 않고 여기 박아둔다 — 출처는 각 관의 공식 관람정보 페이지(homepage)이고,
// 바뀌면 그 페이지를 보고 이 블록만 고친다.
export interface VenueInfo {
  address: string;
  transit: string;
  admission: string;
  // 요일 휴관은 mmcaBusinessHours 의 VENUE_CLOSED_DAYS 와 같은 사실을 말로
  // 옮긴 것이다 — 어긋나면 헤더와 차트가 서로 다른 말을 한다. 여기에는 요일
  // 휴관에 없는 달력 휴관일(1월 1일·설날·추석)까지 함께 적는다.
  closedDays: string;
  // 야간개장이 없는 관은 null (과천관). LONG_CLOSE_DAYS 와 짝이다.
  nightOpening: string | null;
  homepage: string;
}

// 위 두 필드가 영업시간 로직과 어긋나지 않는지는 tests/venueInfo.test.ts 가
// 지킨다 — 과천관이 실제로 그렇게 어긋나 있었다.
const MMCA_NIGHT_OPENING = "수·토 21:00까지 (18시 이후 무료)";
// 서울관·과천관은 요일 휴관이 없고, 덕수궁관·과천관은 매주 월요일 쉰다.
const MMCA_HOLIDAY_CLOSED_DAYS = "1월 1일, 설날, 추석";
const MMCA_MONDAY_CLOSED_DAYS = "매주 월요일, 1월 1일";

export interface Venue {
  id: string;
  name: string;
  path: string;
  // 이 관의 첫 판독이 저장된 날(YYYY-MM-DD). 로그 표의 "이전 날짜"가 여기서
  // 멈춘다 — 그 앞은 아무리 넘겨도 "데이터 없음"뿐이다. 수집을 시작한 날이
  // 관마다 달라 각 표가 따로 박아두면 어긋나므로 여기 한 곳에 모은다.
  earliestDate: string;
  // MMCA관이면 /mmca/rooms 파라미터. 없으면 국립중앙박물관
  // (/congestion/current) — 관 종류가 둘뿐이라 판별 유니온까지 갈 이유가 없다.
  mmcaVenue?: MmcaVenue;
  info: VenueInfo;
}

// MMCA 수집기는 세 관을 한 번에 켰으므로 시작일이 같다.
const MMCA_EARLIEST_DATE = "2026-07-26";

export const VENUES: Venue[] = [
  {
    id: "national-museum",
    name: "국립중앙박물관",
    path: "/venues/national-museum",
    earliestDate: "2026-07-16",
    info: {
      address: "서울 용산구 서빙고로 137",
      transit: "4호선·경의중앙선 이촌역 2번 출구",
      admission: "상설전시관 무료 (특별전은 별도)",
      closedDays: "1월 1일, 설날, 추석",
      nightOpening: "수·토 21:00까지",
      homepage: "https://www.museum.go.kr/MUSEUM/contents/M0101000000.do",
    },
  },
  {
    id: "mmca-seoul",
    name: "국립현대미술관 서울관",
    path: "/venues/mmca-seoul",
    earliestDate: MMCA_EARLIEST_DATE,
    mmcaVenue: "seoul",
    info: {
      address: "서울 종로구 삼청로 30",
      transit: "3호선 안국역 1번 출구",
      admission: "통합관람권 10,000원 (만 24세 이하·65세 이상 무료)",
      closedDays: MMCA_HOLIDAY_CLOSED_DAYS,
      nightOpening: MMCA_NIGHT_OPENING,
      homepage: "https://www.mmca.go.kr/visitingInfo/seoulInfo.do",
    },
  },
  {
    id: "mmca-gwacheon",
    name: "국립현대미술관 과천관",
    path: "/venues/mmca-gwacheon",
    earliestDate: MMCA_EARLIEST_DATE,
    mmcaVenue: "gwacheon",
    info: {
      address: "경기 과천시 광명로 313",
      transit: "4호선 대공원역 4번 출구, 셔틀버스",
      admission: "3,000원 (만 24세 이하·65세 이상 무료)",
      closedDays: MMCA_MONDAY_CLOSED_DAYS,
      // 과천관만 야간개장이 없다 — 수·토도 18:00 폐관.
      nightOpening: null,
      homepage: "https://www.mmca.go.kr/visitingInfo/gwacheonInfo.do",
    },
  },
  {
    id: "mmca-deoksugung",
    // 덕수궁관은 수집 대상이 아니라 "첫 판독"이 없다. 그래도 필드는 비울 수
    // 없으므로 나머지 MMCA관과 같은 날을 쓴다: 수집이 켜졌다면 같은 수집기가
    // 같은 날 저장을 시작했을 날짜라 나중에 켜져도 고칠 일이 없고, 임의의 옛
    // 날짜를 넣어 없는 과거를 넘겨보게 두는 것보다 낫다.
    name: "국립현대미술관 덕수궁관",
    path: "/venues/mmca-deoksugung",
    earliestDate: MMCA_EARLIEST_DATE,
    mmcaVenue: "deoksugung",
    info: {
      address: "서울 중구 세종대로 99 (덕수궁 내)",
      transit: "1·2호선 시청역 1번 출구",
      // 궁 안에 있어 미술관 관람료만으로는 못 들어간다 — 다른 관에 없는
      // 조건이라 금액보다 이 사실이 먼저 읽혀야 한다.
      admission: "2,000원 (덕수궁 입장료 1,000원 별도)",
      closedDays: MMCA_MONDAY_CLOSED_DAYS,
      nightOpening: MMCA_NIGHT_OPENING,
      homepage: "https://www.mmca.go.kr/visitingInfo/deoksugungInfo.do",
    },
  },
];
