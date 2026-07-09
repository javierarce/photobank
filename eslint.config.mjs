import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "src-tauri",
      "node_modules",
      "drizzle",
      "next.config.ts",
      "drizzle.config.ts",
      // Legacy Next.js code, removed once the desktop app reaches parity
      "src/app",
      "src/db",
      "src/worker",
      "src/proxy.ts",
      "src/lib/auth.ts",
      "src/lib/queue.ts",
      "src/lib/redis.ts",
      "src/lib/s3.ts",
      "src/lib/tags.ts",
      "src/__tests__/api",
      "src/__tests__/auth.test.ts",
      "src/__tests__/process-image.test.ts",
      "src/__tests__/use-upload.test.tsx",
    ],
  },
  {
    files: ["**/*.{ts,tsx}", "**/*.mjs"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      reactHooks.configs.flat["recommended-latest"],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
  }
);
