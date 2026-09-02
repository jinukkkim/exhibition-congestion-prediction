import type { MmcaVenue } from "./api/mmca";

// 관 이름 아래 헤더에 실리는 관 단위 정보. 몇 년에 한 번 바뀔 값이라 API 를
// 두지 않고 여기 박아둔다 — 출처는 각 관의 공식 관람정보 페이지(homepage)이고,
// 바뀌면 그 페이지를 보고 이 블록만 고친다.
export interface VenueInfo {
  address: string;
  transit: string;
  admission: string;
  phone: string;
  // 달력 휴관일만 싣는다. 요일 휴관("월요일 휴무")은 영업시간 줄이 영업시간
  // 로직에서 직접 뽑아 말하므로 여기 적으면 같은 말을 두 곳에서 하게 된다.
  closedDays: string;
  homepage: string;
}

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

// 서울관·과천관은 수집기를 한 번에 켰으므로 시작일이 같다 (덕수궁관은 아래 참고).
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
      phone: "02-2077-9000",
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
      // 서울관만 전시별로 따로 판다 — 금액 하나로 접을 수 없어 두 줄이다.
      admission: "개별관람권: 전시별 별도\n통합관람권: 10,000원",
      closedDays: "1월 1일, 설날, 추석",
      phone: "02-3701-9500",
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
      admission: "3,000원",
      closedDays: "1월 1일",
      phone: "02-2188-6000",
      homepage: "https://www.mmca.go.kr/visitingInfo/gwacheonInfo.do",
    },
  },
  {
    id: "mmca-deoksugung",
    name: "국립현대미술관 덕수궁관",
    path: "/venues/mmca-deoksugung",
    // 덕수궁관만 늦게 켜졌다 — 나머지 두 관이 7월 26일에 시작한 동안 이 관은
    // 쿼터 때문에 수집에서 빠져 있었고, 운영 계정으로 바뀐 뒤 이 날 켜졌다.
    earliestDate: "2026-09-03",
    mmcaVenue: "deoksugung",
    info: {
      address: "서울 중구 세종대로 99 (덕수궁 내)",
      transit: "1·2호선 시청역 1번 출구",
      // 궁 안에 있어 미술관 관람료만으로는 못 들어간다 — 다른 관에 없는
      // 조건이라 금액보다 이 사실이 먼저 읽혀야 한다.
      admission: "2,000원 (덕수궁 입장료 1,000원 별도)",
      closedDays: "1월 1일",
      phone: "02-2022-0600",
      homepage: "https://www.mmca.go.kr/visitingInfo/deoksugungInfo.do",
    },
  },
];
