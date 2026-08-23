// 두 로그 표 모두 시각 + 열 수십 개라 가로로 넘친다. 시각 열을 왼쪽에 고정하지
// 않으면 오른쪽 끝 값이 어느 시각의 것인지 알 수 없다.
//
// 스크롤된 셀이 비쳐 보이면 안 되니 불투명 배경을 깔고, 경계선은 border 가
// 아니라 box-shadow 로 준다 — border-collapse 인 표에서는 셀에 준 border 가
// 셀과 함께 붙어 있지 않고 스크롤과 같이 밀려난다.
//
// z 는 쓰는 쪽에서 붙인다: 세로로 붙어 있는 헤더(z-20)가 가로로 붙어 있는 본문
// 시각 열(z-10)보다 위에 와야 하고, 둘 다인 좌상단 모서리가 가장 위(z-30)다.
export const STICKY_TIME_CELL =
  "sticky left-0 whitespace-nowrap bg-white shadow-[1px_0_0_rgba(210,210,215,0.6)]";
