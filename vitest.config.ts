import { config } from "dotenv";
import { defineConfig } from "vitest/config";

config({ path: ".env", quiet: true });

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    globalSetup: ["packages/core/test/global-setup.ts"],
    // Tests share one Postgres database, so files run one at a time.
    fileParallelism: false,
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? "" },
  },
});
