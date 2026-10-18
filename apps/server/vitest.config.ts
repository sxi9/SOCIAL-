import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    teardownTimeout: 15_000,
    pool: 'forks',
    // One suite file at a time: every integration suite shares the one
    // Postgres/Redis, and a few (the §1.63 nudge pool arithmetic, discovery
    // opt-ins, IP-window limits) read whole-table state — two suites
    // interleaving made them flake in CI once startup was serialized.
    fileParallelism: false,
  },
});
