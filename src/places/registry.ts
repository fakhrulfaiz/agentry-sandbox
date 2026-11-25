/**
 * The places a sandbox can run on: the built-in `local` Docker place plus the
 * ones the admin configured (stored in `store.places`, credentials sealed).
 * The registry turns stored records into live drivers; `reload()` re-reads
 * them after an admin edit. Drivers of unchanged places are kept.
 */
import type { SandboxConfig } from '../config.ts'
import { openSecrets } from '../crypto/secrets.ts'
import type { GpuInfo, PlaceRecord, Store } from '../store/types.ts'
import type { Driver } from './driver.ts'

export const LOCAL_PLACE_ID = 'local'

export interface Place {
  id: string
  name: string
  kind: string
  enabled: boolean
  isDefault: boolean
  maxRunning: number | null
  driver: Driver
  gpus: GpuInfo[]
}

export type DriverFactory = (record: PlaceRecord, secrets: Record<string, string>) => Driver

export interface PlaceRegistry {
  /** Default first, then by name. */
  list(): Place[]
  get(id: string): Place | undefined
  default(): Place
  /** Re-reads the stored places (after admin edits). */
  reload(): Promise<void>
  makeDriver: DriverFactory
}

export async function createPlaceRegistry(deps: { store: Store; config: SandboxConfig; local: Driver; drivers: Record<string, DriverFactory> }): Promise<PlaceRegistry> {
  const { store, config, local, drivers } = deps
  let places = new Map<string, Place>()
  /** Live drivers by place id, with the record version they were built from. */
  const built = new Map<string, { stamp: string; driver: Driver }>()

  const makeDriver: DriverFactory = (record, secrets) => {
    const factory = drivers[record.kind]
    if (!factory) throw new Error(`unknown place kind '${record.kind}'`)
    return factory(record, secrets)
  }

  const stampOf = (r: PlaceRecord) => `${r.kind}:${String(r.updatedAt)}`

  async function reload(): Promise<void> {
    const records = await store.places.list()
    const next = new Map<string, Place>()
    const stored = new Map(records.map((r) => [r.id, r]))
    const localRec = stored.get(LOCAL_PLACE_ID)
    next.set(LOCAL_PLACE_ID, {
      id: LOCAL_PLACE_ID,
      name: localRec?.name ?? 'Local Docker',
      kind: local.kind,
      enabled: localRec?.enabled ?? true,
      isDefault: localRec?.isDefault ?? false,
      maxRunning: localRec?.maxRunning ?? null,
      driver: local,
      gpus: localRec?.gpus ?? [],
    })
    const seen = new Set<string>([LOCAL_PLACE_ID])
    for (const r of records) {
      if (r.id === LOCAL_PLACE_ID) continue
      let entry = built.get(r.id)
      if (!entry || entry.stamp !== stampOf(r)) {
        let driver: Driver
        try {
          driver = makeDriver(r, r.secrets ? openSecrets(config.secret, r.secrets) : {})
        } catch {
          // A place that cannot be built (unknown kind, unreadable secrets) is left out; its sandboxes report it unavailable.
          continue
        }
        if (entry) await entry.driver.close?.().catch(() => {})
        entry = { stamp: stampOf(r), driver }
        built.set(r.id, entry)
      }
      seen.add(r.id)
      next.set(r.id, { id: r.id, name: r.name, kind: r.kind, enabled: r.enabled, isDefault: r.isDefault, maxRunning: r.maxRunning, driver: entry.driver, gpus: r.gpus ?? [] })
    }
    for (const [id, e] of built) {
      if (!seen.has(id)) {
        built.delete(id)
        await e.driver.close?.().catch(() => {})
      }
    }
    // Exactly one default: the stored one (enabled), else the local place.
    const chosen = [...next.values()].find((p) => p.isDefault && p.enabled) ?? next.get(LOCAL_PLACE_ID)!
    for (const p of next.values()) p.isDefault = p === chosen
    places = next
  }

  await reload()
  return {
    list: () => [...places.values()].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name)),
    get: (id) => places.get(id),
    default: () => [...places.values()].find((p) => p.isDefault) ?? places.get(LOCAL_PLACE_ID)!,
    reload,
    makeDriver,
  }
}
