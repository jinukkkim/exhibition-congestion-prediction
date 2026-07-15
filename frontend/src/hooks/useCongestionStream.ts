import { useEffect, useState } from "react";

import type { CurrentCongestion } from "../api/congestion";

export function useCongestionStream(
  initial: CurrentCongestion | null
): CurrentCongestion | null {
  const [current, setCurrent] = useState<CurrentCongestion | null>(initial);

  useEffect(() => {
    const source = new EventSource("/congestion/stream");
    source.onmessage = (event: MessageEvent) => {
      setCurrent(JSON.parse(event.data));
    };
    return () => source.close();
  }, []);

  return current;
}
