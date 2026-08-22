import { defineConfig } from "@playwright/test";

// 포트를 고정하면 5173 에 다른 체크아웃(워크트리·메인)의 dev 서버가 이미 떠
// 있을 때 reuseExistingServer 가 그것을 그대로 붙잡아, e2e 가 지금 코드가 아닌
// 남의 코드를 검사하고도 초록으로 끝난다. E2E_PORT 로 워크트리마다 분리한다.
const port = Number(process.env.E2E_PORT ?? 5173);

export default defineConfig({
  testDir: "./e2e",
  webServer: {
    command: `npm run dev -- --port ${port} --strictPort`,
    port,
    reuseExistingServer: true,
  },
  use: {
    baseURL: `http://localhost:${port}`,
  },
});
