import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/__tests__/setup.ts"],
    exclude: [
      "**/node_modules/**",
      // Legacy Next.js API/worker tests, removed once the desktop app
      // reaches parity
      "src/__tests__/api/**",
      "src/__tests__/auth.test.ts",
      "src/__tests__/process-image.test.ts",
      "src/__tests__/use-upload.test.tsx",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
