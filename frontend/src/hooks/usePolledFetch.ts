import { useEffect, useRef, useState } from "react";

interface PollOptions {
  intervalMs: number;
  // 값이 한 번 도착하면 폴링을 멈춘다. 다시 요청해도 같은 답이 오는 데이터
  // (지난주 로그, 일 1회 배치 예측)에 쓴다 — 실패했을 때만 다음 tick에 재시도.
  stopWhenLoaded?: boolean;
}

/**
 * 주기적으로 fetch하고, 실패해도 직전 값을 유지하는 훅.
 *
 * `error`는 "보여줄 게 아무것도 없는 실패"만 뜻한다. 값을 한 번이라도 받은
 * 뒤의 실패는 다음 tick이 회복하므로 화면을 에러로 바꾸지 않는다.
 *
 * `deps`가 바뀌면 다른 대상을 보게 되므로 값과 에러를 모두 초기화한다.
 */
export function usePolledFetch<T>(
  fetcher: () => Promise<T>,
  { intervalMs, stopWhenLoaded = false }: PollOptions,
  deps: unknown[] = []
): { data: T | null; error: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);

  // fetcher는 매 렌더 새로 만들어지는 함수라 effect의 deps에 넣으면 폴링이
  // 렌더마다 재시작한다. 최신 함수는 ref로 들고, 재시작 여부는 호출부가 준
  // deps로만 판단한다.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let ignore = false;
    let seq = 0;
    let timer: ReturnType<typeof setInterval>;
    let hasData = false;

    setData(null);
    setError(false);

    function load() {
      // tick N의 응답이 tick N+1보다 늦게 도착하면 최신 값을 과거 값으로
      // 덮어쓰므로, 발사 시점의 tick 번호가 아직 최신일 때만 반영한다.
      const mySeq = ++seq;
      fetcherRef
        .current()
        .then((value) => {
          if (ignore || mySeq !== seq) return;
          hasData = true;
          setData(value);
          setError(false);
          if (stopWhenLoaded) clearInterval(timer);
        })
        .catch(() => {
          if (ignore || mySeq !== seq) return;
          if (!hasData) setError(true);
        });
    }

    load();
    timer = setInterval(load, intervalMs);

    return () => {
      ignore = true;
      clearInterval(timer);
    };
  }, deps);

  return { data, error };
}
