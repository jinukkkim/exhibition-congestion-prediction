import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePolledFetch } from "../src/hooks/usePolledFetch";

describe("usePolledFetch", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exposes the fetched value", async () => {
    const fetcher = vi.fn().mockResolvedValue("a");

    const { result } = renderHook(() => usePolledFetch(fetcher, { intervalMs: 1000 }));

    await waitFor(() => expect(result.current.data).toBe("a"));
    expect(result.current.error).toBe(false);
  });

  it("reports an error while nothing has loaded yet", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => usePolledFetch(fetcher, { intervalMs: 1000 }));

    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it("keeps the last value and stays out of the error state when a later poll fails", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce("a").mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => usePolledFetch(fetcher, { intervalMs: 1000 }));

    await waitFor(() => expect(result.current.data).toBe("a"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(result.current.data).toBe("a");
    expect(result.current.error).toBe(false);
  });

  it("keeps polling on the given interval", async () => {
    const fetcher = vi.fn().mockResolvedValue("a");

    renderHook(() => usePolledFetch(fetcher, { intervalMs: 1000 }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("ignores a slow response from an earlier tick", async () => {
    let resolveStale: ((value: string) => void) | undefined;
    const stalePending = new Promise<string>((resolve) => {
      resolveStale = resolve;
    });
    const fetcher = vi.fn().mockReturnValueOnce(stalePending).mockResolvedValue("fresh");

    const { result } = renderHook(() => usePolledFetch(fetcher, { intervalMs: 1000 }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await waitFor(() => expect(result.current.data).toBe("fresh"));

    await act(async () => {
      resolveStale?.("stale");
    });

    expect(result.current.data).toBe("fresh");
  });

  it("stops polling once loaded when stopWhenLoaded is set", async () => {
    const fetcher = vi.fn().mockResolvedValue("a");

    const { result } = renderHook(() =>
      usePolledFetch(fetcher, { intervalMs: 1000, stopWhenLoaded: true })
    );

    await waitFor(() => expect(result.current.data).toBe("a"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries on the interval until it loads when stopWhenLoaded is set", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue("a");

    const { result } = renderHook(() =>
      usePolledFetch(fetcher, { intervalMs: 1000, stopWhenLoaded: true })
    );

    await waitFor(() => expect(result.current.error).toBe(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(result.current.data).toBe("a");
    expect(result.current.error).toBe(false);
  });

  it("resets to a clean slate when deps change", async () => {
    const fetcher = vi.fn().mockResolvedValue("a");

    const { result, rerender } = renderHook(
      ({ dep }: { dep: string }) => usePolledFetch(fetcher, { intervalMs: 1000 }, [dep]),
      { initialProps: { dep: "first" } }
    );

    await waitFor(() => expect(result.current.data).toBe("a"));

    fetcher.mockReturnValue(new Promise(() => {})); // 두 번째 대상은 아직 응답 없음
    rerender({ dep: "second" });

    expect(result.current.data).toBeNull();
  });

  it("does not restart polling when only the fetcher identity changes", async () => {
    const calls: number[] = [];
    const { rerender } = renderHook(
      ({ n }: { n: number }) =>
        usePolledFetch(
          () => {
            calls.push(n);
            return Promise.resolve(n);
          },
          { intervalMs: 1000 }
        ),
      { initialProps: { n: 1 } }
    );

    await waitFor(() => expect(calls).toEqual([1]));
    rerender({ n: 2 });
    expect(calls).toEqual([1]);

    // 다음 tick은 최신 fetcher를 써야 한다
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(calls).toEqual([1, 2]);
  });
});
