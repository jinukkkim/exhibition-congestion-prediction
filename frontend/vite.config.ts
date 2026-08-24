import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 워크트리마다 백엔드를 다른 포트로 띄울 수 있게 — 8000 을 고정하면 다른
// 체크아웃에서 돌고 있는 백엔드로 프록시된다 (playwright.config.ts 의 E2E_PORT
// 와 같은 이유).
const apiTarget = process.env.VITE_API_TARGET ?? "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/congestion": apiTarget,
      "/mmca": apiTarget,
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./vitest.setup.ts",
    exclude: ["**/node_modules/**", "**/e2e/**"],
    // 앱은 한 타임존만 산다 — lib/date.ts 의 todayString() 은 Asia/Seoul 로
    // 못박혀 있고, 영업시간 판정은 브라우저 로컬 시각을 쓴다. 러너가 KST 가
    // 아니면 이 둘이 갈라져서, 테스트가 고정한 시각("2026-08-20T14:20:00" 처럼
    // 존 없는 리터럴 = 로컬 파싱)과 컴포넌트가 보는 "오늘"이 하루씩 어긋난다.
    // CI 는 UTC 라 실제로 갈라진다. 스위트 전체를 KST 로 고정해서 리터럴이
    // 적힌 그대로의 벽시계를 뜻하게 한다.
    env: { TZ: "Asia/Seoul" },
  },
});
