import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Payroll/attendance logic lives in Postgres. These are integration tests
    // that connect to a real database via DATABASE_URL. They mutate a schema,
    // so they must run serially, not in parallel worker threads.
    include: ["tests/**/*.spec.ts"],
    globalSetup: ["tests/global-setup.ts"],
    fileParallelism: false,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    hookTimeout: 30_000,
    testTimeout: 30_000,
    globals: false,
  },
});
