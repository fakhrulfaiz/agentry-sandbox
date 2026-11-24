import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // Docker suites share one daemon; keep files serial so cleanup by label cannot race.
    fileParallelism: false,
  },
})
