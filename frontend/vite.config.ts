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
  },
});
