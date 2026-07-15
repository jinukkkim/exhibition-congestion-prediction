import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/congestion": "http://localhost:8000",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./vitest.setup.ts",
    exclude: ["**/node_modules/**", "**/e2e/**"],
  },
});
