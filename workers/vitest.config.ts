import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const migrations = await readD1Migrations(path.join(root, "migrations"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: path.join(root, "wrangler.test.toml") },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          OMNICORE_ADMIN_KEY: "local-integration-admin",
          RATE_LIMIT_REQUESTS: "3",
          RATE_LIMIT_WINDOW_SECONDS: "60",
        },
      },
    }),
  ],
  test: {
    include: ["src/**/*.integration.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
    testTimeout: 15_000,
  },
});
