import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The daemon owns a SQLite file per test, and better-sqlite3 is synchronous.
    // Threads keep those files from colliding without a per-suite lock.
    pool: 'threads',
    testTimeout: 20_000,
  },
})
