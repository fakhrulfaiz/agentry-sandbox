/** In-memory Store for tests; same contract as the Postgres store. */
import type { PlaceRecord, SandboxRecord, Store, TemplateRecord } from './types.ts'

const copy = <T>(v: T): T => structuredClone(v)

export function createMemoryStore(): Store {
  const sandboxes = new Map<string, SandboxRecord>()
  const templates = new Map<string, TemplateRecord>()
  const places = new Map<string, PlaceRecord>()
  const settings = new Map<string, unknown>()
  const owned = <T extends { owner: string }>(m: Map<string, T>, id: string, owner: string) => {
    const r = m.get(id)
    return r && r.owner === owner ? r : undefined
  }
  return {
    sandboxes: {
      async insert(r) {
        if (sandboxes.has(r.id)) throw new Error(`duplicate sandbox ${r.id}`)
        sandboxes.set(r.id, copy(r))
      },
      async get(id, owner) {
        const r = owned(sandboxes, id, owner)
        return r && copy(r)
      },
      async getAny(id) {
        const r = sandboxes.get(id)
        return r && copy(r)
      },
      async list(owner) {
        return [...sandboxes.values()].filter((r) => r.owner === owner).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map(copy)
      },
      async update(id, owner, patch) {
        const r = owned(sandboxes, id, owner)
        if (!r) return undefined
        Object.assign(r, copy(patch))
        return copy(r)
      },
      async delete(id, owner) {
        return owned(sandboxes, id, owner) ? sandboxes.delete(id) : false
      },
      async listAll() {
        return [...sandboxes.values()].map(copy)
      },
    },
    templates: {
      async insert(r) {
        if (templates.has(r.id)) throw new Error(`duplicate template ${r.id}`)
        templates.set(r.id, copy(r))
      },
      async get(id, owner) {
        const r = owned(templates, id, owner)
        return r && copy(r)
      },
      async list(owner) {
        return [...templates.values()].filter((r) => r.owner === owner).sort((a, b) => a.createdAt - b.createdAt).map(copy)
      },
      async update(id, owner, patch) {
        const r = owned(templates, id, owner)
        if (!r) return undefined
        Object.assign(r, copy(patch))
        return copy(r)
      },
      async delete(id, owner) {
        return owned(templates, id, owner) ? templates.delete(id) : false
      },
    },
    places: {
      async list() {
        return [...places.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map(copy)
      },
      async get(id) {
        const r = places.get(id)
        return r && copy(r)
      },
      async insert(r) {
        if (places.has(r.id)) throw new Error(`duplicate place ${r.id}`)
        if (r.isDefault) for (const p of places.values()) p.isDefault = false
        places.set(r.id, copy(r))
      },
      async update(id, patch) {
        const r = places.get(id)
        if (!r) return undefined
        if (patch.isDefault) for (const p of places.values()) p.isDefault = false
        Object.assign(r, copy(Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))))
        return copy(r)
      },
      async delete(id) {
        return places.delete(id)
      },
    },
    settings: {
      async get(key) {
        return settings.has(key) ? structuredClone(settings.get(key)) : undefined
      },
      async set(key, value) {
        if (value === undefined) settings.delete(key)
        else settings.set(key, structuredClone(value))
      },
    },
    async close() {},
  }
}
