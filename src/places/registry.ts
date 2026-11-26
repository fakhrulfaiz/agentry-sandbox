/**
 * The places a sandbox can run on: the built-in `local` Docker place plus the
 * ones the admin configured (stored in `store.places`, credentials sealed).
 * The registry turns stored records into live drivers; `reload()` re-reads
 * them after an admin edit. Drivers of unchanged places are kept.
 */
import type { SandboxConfig } from '../config.ts'
import { openSecrets } from '../crypto/secrets.ts'
import type { GpuInfo, PlaceRecord, Store } from '../store/types.ts'
import type { Availability, Driver } from './driver.ts'

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
  /** The driver's reachability, cached briefly and cut off after a few seconds, so a dead host never stalls a request or the sweep. */
  probe(): Promise<ProbeResult>
}

export type ProbeResult = Availability & { gpus?: GpuInfo[] }

/** `forTest`: the admin's connection test (a remote driver may then connect without a pinned host key). */
export type DriverFactory = (record: PlaceRecord, secrets: Record<string, string>, opts?: { forTest?: boolean }) => Driver

export interface PlaceRegistry {
  /** Default first, then by name. */
  list(): Place[]
  get(id: string): Place | undefined
  default(): Place
  /** Re-reads the stored places (after admin edits). */
  reload(): Promise<void>
  makeDriver: DriverFactory
}

export interface ProbeOptions {
  /** How long a probe result is reused (default 0: always probe; the service sets 30 s). */
  probeTtlMs?: number
  /** A probe that takes longer counts as unreachable (default 5 s). */
  probeTimeoutMs?: number
}

export async function createPlaceRegistry(deps: { store: Store; config: SandboxConfig; local: Driver; drivers: Record<string, DriverFactory> } & ProbeOptions): Promise<PlaceRegistry> {
  const { store, config, local, drivers } = deps
  const ttl = deps.probeTtlMs ?? 0
  const timeout = deps.probeTimeoutMs ?? 5_000
  const probes = new WeakMap<Driver, { at: number; result: Promise<ProbeResult> }>()
  /** One cached probe per driver (shared by every Place object made from it, so reloads keep it). */
  const probeOf = (driver: Driver) => (): Promise<ProbeResult> => {
    const hit = probes.get(driver)
    if (hit && Date.now() - hit.at < ttl) return hit.result
    let timer: ReturnType<typeof setTimeout> | undefined
    const result = Promise.race([
      driver.probe().catch((e: unknown): ProbeResult => ({ ok: false, reason: e instanceof Error ? e.message : String(e) })),
      new Promise<ProbeResult>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: `no answer within ${String(timeout)} ms` }), timeout)
      }),
    ]).finally(() => clearTimeout(timer))
    if (ttl > 0) probes.set(driver, { at: Date.now(), result })
    return result
  }
  let places = new Map<string, Place>()
  /** Live drivers by place id, with the record version they were built from. */
  const built = new Map<string, { stamp: string; driver: Driver }>()

  const makeDriver: DriverFactory = (record, secrets, opts) => {
    const factory = drivers[record.kind]
    if (!factory) throw new Error(`unknown place kind '${record.kind}'`)
    return factory(record, secrets, opts)
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
      probe: probeOf(local),
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
      next.set(r.id, { id: r.id, name: r.name, kind: r.kind, enabled: r.enabled, isDefault: r.isDefault, maxRunning: r.maxRunning, driver: entry.driver, gpus: r.gpus ?? [], probe: probeOf(entry.driver) })
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
