import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCongestionStream } from "../src/hooks/useCongestionStream";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {}

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useCongestionStream", () => {
  it("updates state when a message arrives", () => {
    const { result } = renderHook(() => useCongestionStream(null));

    expect(result.current).toBeNull();

    const source = FakeEventSource.instances[0];
    act(() => {
      source.emit({
        observed_at: "2026-07-15T15:00:00",
        congest_level: "붐빔",
        population_avg: 3000,
      });
    });

    expect(result.current?.congest_level).toBe("붐빔");
  });

  it("adopts a populated `initial` once the REST fetch resolves after first render", () => {
    const fetched = {
      observed_at: "2026-07-15T15:00:00",
      congest_level: "보통",
      population_avg: 1200,
    };

    const { result, rerender } = renderHook(
      ({ initial }) => useCongestionStream(initial),
      { initialProps: { initial: null as typeof fetched | null } }
    );

    expect(result.current).toBeNull();

    rerender({ initial: fetched });

    expect(result.current?.congest_level).toBe("보통");
  });

  it("does not let a later `initial` update clobber a live SSE value", () => {
    const { result, rerender } = renderHook(
      ({ initial }) => useCongestionStream(initial),
      {
        initialProps: {
          initial: null as {
            observed_at: string;
            congest_level: string;
            population_avg: number;
          } | null,
        },
      }
    );

    const source = FakeEventSource.instances[0];
    act(() => {
      source.emit({
        observed_at: "2026-07-15T15:05:00",
        congest_level: "붐빔",
        population_avg: 3200,
      });
    });

    expect(result.current?.congest_level).toBe("붐빔");

    rerender({
      initial: {
        observed_at: "2026-07-15T15:00:00",
        congest_level: "보통",
        population_avg: 1200,
      },
    });

    expect(result.current?.congest_level).toBe("붐빔");
  });
});
