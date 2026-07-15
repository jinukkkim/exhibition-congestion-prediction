import { useEffect, useRef, useState } from "react";

import type { CurrentCongestion } from "../api/congestion";

export function useCongestionStream(
  initial: CurrentCongestion | null
): CurrentCongestion | null {
  const [current, setCurrent] = useState<CurrentCongestion | null>(initial);
  const hasLiveMessage = useRef(false);

  // Bridge: apply the REST-fetched `initial` value whenever it changes,
  // but only until the first live SSE message arrives. After that, SSE
  // is the source of truth and must not be clobbered by a stale `initial`.
  useEffect(() => {
    if (!hasLiveMessage.current) {
      setCurrent(initial);
    }
  }, [initial]);

  useEffect(() => {
    const source = new EventSource("/congestion/stream");
    source.onmessage = (event: MessageEvent) => {
      hasLiveMessage.current = true;
      setCurrent(JSON.parse(event.data));
    };
    return () => source.close();
  }, []);

  return current;
}
