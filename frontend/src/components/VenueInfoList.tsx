import { Fragment } from "react";

import type { VenueInfo } from "../venues";

// 관 이름 아래에 놓이는 관 단위 정보 표. MmcaPage 에서는 이 표가 헤더 왼쪽
// 열의 높이를 오른쪽 전시 목록에 맞춘다 — 그전에는 이름과 영업시간 한 줄뿐이라
// 오른쪽만 길었다. 국중박은 전시 목록이 없어 그냥 아래로 이어진다.
//
// 영업시간 한 줄(businessHoursLine)은 고른 날짜에 따라 바뀌는 값이라 여기에
// 넣지 않는다. 이 표는 날짜와 무관한 값만 싣는다.
export function VenueInfoList({ info }: { info: VenueInfo }) {
  const rows: [string, string][] = [
    ["주소", info.address],
    ["가는 길", info.transit],
    ["관람료", info.admission],
    ["휴관일", info.closedDays],
  ];
  // 야간개장이 없는 관(과천관)은 줄을 지운다 — "없음"은 정보가 아니라 잡음이고,
  // 없는 줄만큼 표가 짧아지는 편이 낫다.
  if (info.nightOpening) rows.push(["야간개장", info.nightOpening]);

  return (
    <dl className="mt-6 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
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
