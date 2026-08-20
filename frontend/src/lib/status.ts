export interface StatusTokens {
  core: string; // full-saturation: dots, strokes, glows — never on top of small text
  text: string; // AA-safe darker variant for status text at small sizes
  wash: string; // low-opacity tint for background glows
}

const STATUS: Record<string, StatusTokens> = {
  여유: { core: "#34C759", text: "#1F8B3B", wash: "rgba(52,199,89,0.16)" },
  보통: { core: "#FFD60A", text: "#8A6D00", wash: "rgba(255,214,10,0.2)" },
  "약간 붐빔": { core: "#FF9F0A", text: "#B15C00", wash: "rgba(255,159,10,0.18)" },
  붐빔: { core: "#FF3B30", text: "#C81E13", wash: "rgba(255,59,48,0.16)" },
};

const FALLBACK: StatusTokens = { core: "#8E8E93", text: "#6E6E73", wash: "rgba(142,142,147,0.14)" };

export function statusOf(level: string): StatusTokens {
  return STATUS[level] ?? FALLBACK;
}

// 혼잡도 낮은 순 → 높은 순. STATUS의 정의 순서를 그대로 따라가므로 레벨 목록이
// 두 군데로 갈라지지 않는다 (문자열 키 객체의 키 순서는 삽입 순서).
export const STATUS_LEVELS = Object.keys(STATUS);
