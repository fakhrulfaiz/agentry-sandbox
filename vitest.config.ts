import { existsSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

/** Local test settings (git-ignored), e.g. AGENTRY_SANDBOX_TEST_DATABASE_URL. */
const env = Object.fromEntries(
  (existsSync('.env.test') ? readFileSync('.env.test', 'utf8') : '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
)

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // Docker suites share one daemon; keep files serial so cleanup by label cannot race.
    fileParallelism: false,
    env,
  },
})
