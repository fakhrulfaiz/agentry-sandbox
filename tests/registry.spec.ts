import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { sealSecrets } from '../src/crypto/secrets.ts'
import { createFakeDriver } from '../src/places/drivers/fake.ts'
import { createPlaceRegistry, LOCAL_PLACE_ID } from '../src/places/registry.ts'
import { createMemoryStore } from '../src/store/memory.ts'
import type { PlaceRecord } from '../src/store/types.ts'

const config = loadConfig({ AGENTRY_SANDBOX_DATABASE_URL: 'postgres://x@localhost/x', AGENTRY_SANDBOX_API_KEYS: `sha256:${'a'.repeat(64)}`, AGENTRY_SANDBOX_SECRET: 's'.repeat(32) })
const rec = (over: Partial<PlaceRecord> = {}): PlaceRecord => ({ id: 'p1', name: 'Zed', kind: 'fake', config: {}, secrets: null, enabled: true, isDefault: false, maxRunning: null, gpus: null, createdAt: 1, updatedAt: 1, ...over })

describe('place registry', () => {
  it('always has the local place, default, named Local Docker', async () => {
    const local = createFakeDriver()
    const reg = await createPlaceRegistry({ store: createMemoryStore(), config, local, drivers: {} })
    expect(reg.list().map((p) => [p.id, p.name, p.isDefault, p.driver === local])).toEqual([[LOCAL_PLACE_ID, 'Local Docker', true, true]])
    expect(reg.default().id).toBe('local')
  })

  it('a stored local record renames it and may take the default off; kind stays', async () => {
    const store = createMemoryStore()
    await store.places.insert(rec({ id: 'local', name: 'Laptop', kind: 'docker-ssh', maxRunning: 2 }))
    await store.places.insert(rec({ id: 'p1', isDefault: true }))
    const reg = await createPlaceRegistry({ store, config, local: createFakeDriver(), drivers: { fake: () => createFakeDriver() } })
    expect(reg.get('local')).toMatchObject({ name: 'Laptop', kind: 'fake', maxRunning: 2, isDefault: false })
    expect(reg.default().id).toBe('p1')
    expect(reg.list().map((p) => p.id)).toEqual(['p1', 'local'])
  })

  it('reload picks up edits, passes opened secrets to the driver factory and skips unbuildable places', async () => {
    const store = createMemoryStore()
    const seen: Record<string, string>[] = []
    const reg = await createPlaceRegistry({ store, config, local: createFakeDriver(), drivers: { fake: (_r, s) => { seen.push(s); return createFakeDriver() } } })
    await store.places.insert(rec({ secrets: sealSecrets(config.secret, { token: 't' }) }))
    await store.places.insert(rec({ id: 'p2', name: 'Alpha', kind: 'mystery' }))
    await reg.reload()
    expect(seen).toEqual([{ token: 't' }])
    expect(reg.list().map((p) => p.id)).toEqual(['local', 'p1'])
    expect(reg.get('p2')).toBeUndefined()
  })
})
