/** Runs against E2B itself; skipped unless AGENTRY_SANDBOX_TEST_E2B_KEY is set. */
import { describe, expect, it } from 'vitest'
import { createE2bDriver } from '../src/places/drivers/e2b.ts'

const key = process.env.AGENTRY_SANDBOX_TEST_E2B_KEY

describe.skipIf(!key)('e2b live', () => {
  it('creates, pauses, resumes and kills a sandbox', async () => {
    const driver = createE2bDriver({ apiKey: key!, template: process.env.AGENTRY_SANDBOX_TEST_E2B_TEMPLATE ?? 'base', apiUrl: 'https://api.e2b.app', sandboxHost: 'https://sandbox.e2b.app', timeoutS: 120 })
    expect(await driver.probe()).toMatchObject({ ok: true })
    const id = `sbx_live_${Date.now().toString(36)}`
    const h = await driver.create(id, 'live-test', {}, { gpuIds: [] })
    try {
      expect(await driver.status(h)).toBe('running')
      await driver.stop(h)
      expect(await driver.status(h)).toBe('stopped')
      const again = await driver.start(id, h, {}, { gpuIds: [] })
      expect(await driver.status(again)).toBe('running')
    } finally {
      await driver.destroy(id, h, { keepWorkspace: false })
    }
    expect(await driver.status(h)).toBe('missing')
  })
})
