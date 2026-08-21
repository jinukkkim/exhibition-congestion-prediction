import { useEffect, useState } from "react";

import type { CurrentCongestion } from "../api/congestion";

// 어느 경로로 온 값이든 관측 시각이 더 최신인 쪽을 남긴다. 같은 포맷의 ISO
// 문자열이라 사전순 = 시간순.
function newer(
  prev: CurrentCongestion | null,
  next: CurrentCongestion | null
): CurrentCongestion | null {
  if (next === null) return prev;
  if (prev === null) return next;
  return next.observed_at > prev.observed_at ? next : prev;
}

export function useCongestionStream(
  initial: CurrentCongestion | null
): CurrentCongestion | null {
  const [current, setCurrent] = useState<CurrentCongestion | null>(initial);

  // SSE와 REST 폴링 두 경로가 같은 값을 갱신한다. "첫 SSE 메시지 이후로는
  // SSE만 신뢰"하는 식으로 고정하면 스트림이 죽은 뒤 폴링으로 들어온 새 값이
  // 버려져 화면이 마지막 SSE 값에 얼어붙는다. 그래서 출처가 아니라 관측
  // 시각으로 판정한다.
  useEffect(() => {
    setCurrent((prev) => newer(prev, initial));
  }, [initial]);

  useEffect(() => {
    const source = new EventSource("/congestion/stream");
    source.onmessage = (event: MessageEvent) => {
      const next = JSON.parse(event.data) as CurrentCongestion;
      setCurrent((prev) => newer(prev, next));
    };
    return () => source.close();
  }, []);

  return current;
}
