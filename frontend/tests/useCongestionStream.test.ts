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
});
