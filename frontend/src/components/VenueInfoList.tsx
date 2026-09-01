import { Fragment } from "react";

import { businessHoursLine } from "../lib/businessHoursLine";
import type { Venue } from "../venues";

// 관 이름 아래에 놓이는 관 단위 정보 표. MmcaPage 에서는 이 표가 헤더 왼쪽
// 열의 높이를 오른쪽 전시 목록에 맞춘다 — 그전에는 이름과 영업시간 한 줄뿐이라
// 오른쪽만 길었다. 국중박은 전시 목록이 없어 그냥 아래로 이어진다.
//
// 위쪽 여백은 호출부가 준다 — 이 표의 첫 줄이 옆 열의 첫 줄과 같은 높이에
// 서야 하므로, 여백이 컴포넌트 안에 있으면 두 열을 함께 맞출 수 없다.
export function VenueInfoList({ venue }: { venue: Venue }) {
  const { info } = venue;
  const rows: [string, string][] = [
    // 영업시간만 정적 문구가 아니라 영업시간 로직에서 뽑는다 — 차트 축과 같은
    // 값이라 어긋날 수 없다. 나머지는 venues.ts 에 적힌 그대로다.
    ["영업시간", businessHoursLine(venue)],
    ["주소", info.address],
    ["가는 길", info.transit],
    ["관람료", info.admission],
    ["휴관일", info.closedDays],
  ];

  // content-start: 이 표가 2열 그리드의 아이템이면 옆 열 높이에 맞춰 늘어나고,
  // 그 여분이 행 사이로 퍼져 줄 간격이 벌어진다. 행은 위에 붙여 둔다.
  return (
    <dl className="grid content-start grid-cols-[4.5rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([label, value]) => (
        <Fragment key={label}>
          <dt className="text-ink-soft">{label}</dt>
          <dd className="text-ink">{value}</dd>
        </Fragment>
      ))}
      {/* 금액·시간은 우리가 베껴 둔 값이라 언젠가 어긋난다. 원본으로 가는 길을
          같은 표 안에 둔다. dl 은 dt 없는 dd 를 두면 안 되므로 dt 는 남기고
          화면에서만 감춘다. */}
      <dt className="sr-only">공식 안내</dt>
      <dd className="col-start-2 mt-1">
        <a
          href={info.homepage}
          target="_blank"
          rel="noreferrer"
          className="text-ink-soft underline decoration-hairline underline-offset-4 hover:text-accent"
        >
          공식 관람 안내 →
        </a>
      </dd>
    </dl>
  );
}
