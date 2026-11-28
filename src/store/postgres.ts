/** Postgres Store: the `sandboxes` and `templates` tables from `migrations/`. */
import type pg from 'pg'
import type { PlacePatch, PlaceRecord, SandboxPatch, SandboxRecord, SnapshotPatch, SnapshotRecord, Store, TemplatePatch, TemplateRecord } from './types.ts'

interface SandboxRow {
  id: string
  owner: string
  name: string
  backend: string
  template: SandboxRecord['template']
  template_id: string | null
  state: SandboxRecord['state']
  handle: Record<string, string>
  handle_secrets: string | null
  error: string | null
  progress: SandboxRecord['progress']
  created_at: Date
  started_at: Date | null
  last_used_at: Date | null
}
interface PlaceRow {
  id: string
  name: string
  kind: string
  config: Record<string, unknown>
  secrets: string | null
  enabled: boolean
  is_default: boolean
  max_running: number | null
  gpus: PlaceRecord['gpus']
  created_at: Date
  updated_at: Date
}
interface SnapshotRow {
  id: string
  owner: string
  sandbox_id: string
  place: string
  level: SnapshotRecord['level']
  name: string
  state: SnapshotRecord['state']
  handle: Record<string, string>
  handle_secrets: string | null
  // bigint comes back from pg as a string
  size_bytes: string | null
  error: string | null
  created_at: Date
  expires_at: Date | null
}
interface TemplateRow {
  id: string
  owner: string
  name: string
  spec: TemplateRecord['spec']
  created_at: Date
  updated_at: Date
}

const ms = (d: Date | null) => (d === null ? null : d.getTime())
const ts = (n: number | null) => (n === null ? null : new Date(n))

const sandboxOf = (r: SandboxRow): SandboxRecord => ({
  id: r.id,
  owner: r.owner,
  name: r.name,
  backend: r.backend,
  template: r.template,
  templateId: r.template_id,
  state: r.state,
  handle: r.handle,
  handleSecrets: r.handle_secrets,
  error: r.error,
  progress: r.progress ?? null,
  createdAt: r.created_at.getTime(),
  startedAt: ms(r.started_at),
  lastUsedAt: ms(r.last_used_at),
})
const templateOf = (r: TemplateRow): TemplateRecord => ({ id: r.id, owner: r.owner, name: r.name, spec: r.spec, createdAt: r.created_at.getTime(), updatedAt: r.updated_at.getTime() })

const snapshotOf = (r: SnapshotRow): SnapshotRecord => ({
  id: r.id,
  owner: r.owner,
  sandboxId: r.sandbox_id,
  place: r.place,
  level: r.level,
  name: r.name,
  state: r.state,
  handle: r.handle,
  handleSecrets: r.handle_secrets,
  sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
  error: r.error,
  createdAt: r.created_at.getTime(),
  expiresAt: ms(r.expires_at),
})

const placeOf = (r: PlaceRow): PlaceRecord => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  config: r.config,
  secrets: r.secrets,
  enabled: r.enabled,
  isDefault: r.is_default,
  maxRunning: r.max_running,
  gpus: r.gpus,
  createdAt: r.created_at.getTime(),
  updatedAt: r.updated_at.getTime(),
})

type Column = [string, (v: unknown) => unknown]

/** Patchable sandbox fields → column and conversion. */
const SANDBOX_COLUMNS: Record<keyof SandboxPatch, Column> = {
  name: ['name', (v) => v],
  template: ['template', (v) => JSON.stringify(v)],
  state: ['state', (v) => v],
  handle: ['handle', (v) => JSON.stringify(v)],
  handleSecrets: ['handle_secrets', (v) => v],
  error: ['error', (v) => v],
  progress: ['progress', (v) => (v === null ? null : JSON.stringify(v))],
  startedAt: ['started_at', (v) => ts((v as number | null) ?? null)],
  lastUsedAt: ['last_used_at', (v) => ts((v as number | null) ?? null)],
}
const PLACE_COLUMNS: Record<keyof PlacePatch, Column> = {
  name: ['name', (v) => v],
  kind: ['kind', (v) => v],
  config: ['config', (v) => JSON.stringify(v)],
  secrets: ['secrets', (v) => v],
  enabled: ['enabled', (v) => v],
  isDefault: ['is_default', (v) => v],
  maxRunning: ['max_running', (v) => v],
  gpus: ['gpus', (v) => (v === null ? null : JSON.stringify(v))],
  updatedAt: ['updated_at', (v) => ts((v as number | null) ?? null)],
}
const SNAPSHOT_COLUMNS: Record<keyof SnapshotPatch, Column> = {
  name: ['name', (v) => v],
  state: ['state', (v) => v],
  handle: ['handle', (v) => JSON.stringify(v)],
  handleSecrets: ['handle_secrets', (v) => v],
  sizeBytes: ['size_bytes', (v) => v],
  error: ['error', (v) => v],
  expiresAt: ['expires_at', (v) => ts((v as number | null) ?? null)],
}
const TEMPLATE_COLUMNS: Record<keyof TemplatePatch, Column> = {
  name: ['name', (v) => v],
  spec: ['spec', (v) => JSON.stringify(v)],
  updatedAt: ['updated_at', (v) => ts((v as number | null) ?? null)],
}

function setClause(patch: object, columns: Record<string, Column>, start: number): { sql: string; values: unknown[] } {
  const sets: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(patch)) {
    const col = columns[key]
    if (!col || value === undefined) continue
    values.push(col[1](value))
    sets.push(`${col[0]} = $${String(start + values.length - 1)}`)
  }
  return { sql: sets.join(', '), values }
}

export function createPostgresStore(pool: pg.Pool, opts: { ownsPool: boolean } = { ownsPool: true }): Store {
  const one = <T>(rows: T[]) => rows[0]
  const getSandbox = async (id: string, owner: string) => {
    const row = one((await pool.query<SandboxRow>('select * from sandboxes where id = $1 and owner = $2', [id, owner])).rows)
    return row && sandboxOf(row)
  }
  const getTemplate = async (id: string, owner: string) => {
    const row = one((await pool.query<TemplateRow>('select * from templates where id = $1 and owner = $2', [id, owner])).rows)
    return row && templateOf(row)
  }
  async function inTransaction<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect()
    try {
      await c.query('begin')
      const out = await fn(c)
      await c.query('commit')
      return out
    } catch (error) {
      await c.query('rollback').catch(() => {})
      throw error
    } finally {
      c.release()
    }
  }
  return {
    sandboxes: {
      async insert(r) {
        await pool.query(
          `insert into sandboxes (id, owner, name, backend, template, template_id, state, handle, handle_secrets, error, created_at, started_at, last_used_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [r.id, r.owner, r.name, r.backend, JSON.stringify(r.template), r.templateId, r.state, JSON.stringify(r.handle), r.handleSecrets, r.error, ts(r.createdAt), ts(r.startedAt), ts(r.lastUsedAt)],
        )
      },
      get: getSandbox,
      async getAny(id) {
        const row = one((await pool.query<SandboxRow>('select * from sandboxes where id = $1', [id])).rows)
        return row && sandboxOf(row)
      },
      async list(owner) {
        return (await pool.query<SandboxRow>('select * from sandboxes where owner = $1 order by created_at, id', [owner])).rows.map(sandboxOf)
      },
      async update(id, owner, patch) {
        const { sql, values } = setClause(patch, SANDBOX_COLUMNS, 3)
        if (!sql) return getSandbox(id, owner)
        const row = one((await pool.query<SandboxRow>(`update sandboxes set ${sql} where id = $1 and owner = $2 returning *`, [id, owner, ...values])).rows)
        return row && sandboxOf(row)
      },
      async delete(id, owner) {
        return ((await pool.query('delete from sandboxes where id = $1 and owner = $2', [id, owner])).rowCount ?? 0) > 0
      },
      async listAll() {
        return (await pool.query<SandboxRow>('select * from sandboxes order by created_at, id')).rows.map(sandboxOf)
      },
    },
    templates: {
      async insert(r) {
        await pool.query('insert into templates (id, owner, name, spec, created_at, updated_at) values ($1, $2, $3, $4, $5, $6)', [
          r.id, r.owner, r.name, JSON.stringify(r.spec), ts(r.createdAt), ts(r.updatedAt),
        ])
      },
      get: getTemplate,
      async list(owner) {
        return (await pool.query<TemplateRow>('select * from templates where owner = $1 order by created_at, id', [owner])).rows.map(templateOf)
      },
      async update(id, owner, patch) {
        const { sql, values } = setClause(patch, TEMPLATE_COLUMNS, 3)
        if (!sql) return getTemplate(id, owner)
        const row = one((await pool.query<TemplateRow>(`update templates set ${sql} where id = $1 and owner = $2 returning *`, [id, owner, ...values])).rows)
        return row && templateOf(row)
      },
      async delete(id, owner) {
        return ((await pool.query('delete from templates where id = $1 and owner = $2', [id, owner])).rowCount ?? 0) > 0
      },
    },
    snapshots: {
      async insert(r) {
        await pool.query(
          `insert into snapshots (id, owner, sandbox_id, place, level, name, state, handle, handle_secrets, size_bytes, error, created_at, expires_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [r.id, r.owner, r.sandboxId, r.place, r.level, r.name, r.state, JSON.stringify(r.handle), r.handleSecrets, r.sizeBytes, r.error, ts(r.createdAt), ts(r.expiresAt)],
        )
      },
      async get(id, owner) {
        const row = one((await pool.query<SnapshotRow>('select * from snapshots where id = $1 and owner = $2', [id, owner])).rows)
        return row && snapshotOf(row)
      },
      async getAny(id) {
        const row = one((await pool.query<SnapshotRow>('select * from snapshots where id = $1', [id])).rows)
        return row && snapshotOf(row)
      },
      async list(owner, opts = {}) {
        const rows = opts.sandboxId === undefined
          ? (await pool.query<SnapshotRow>('select * from snapshots where owner = $1 order by created_at, id', [owner])).rows
          : (await pool.query<SnapshotRow>('select * from snapshots where owner = $1 and sandbox_id = $2 order by created_at, id', [owner, opts.sandboxId])).rows
        return rows.map(snapshotOf)
      },
      async update(id, owner, patch) {
        const { sql, values } = setClause(patch, SNAPSHOT_COLUMNS, 3)
        if (!sql) {
          const row = one((await pool.query<SnapshotRow>('select * from snapshots where id = $1 and owner = $2', [id, owner])).rows)
          return row && snapshotOf(row)
        }
        const row = one((await pool.query<SnapshotRow>(`update snapshots set ${sql} where id = $1 and owner = $2 returning *`, [id, owner, ...values])).rows)
        return row && snapshotOf(row)
      },
      async delete(id, owner) {
        return ((await pool.query('delete from snapshots where id = $1 and owner = $2', [id, owner])).rowCount ?? 0) > 0
      },
      async listAll() {
        return (await pool.query<SnapshotRow>('select * from snapshots order by created_at, id')).rows.map(snapshotOf)
      },
      async listExpired(at) {
        return (await pool.query<SnapshotRow>('select * from snapshots where expires_at is not null and expires_at <= $1 order by created_at, id', [ts(at)])).rows.map(snapshotOf)
      },
    },
    places: {
      async list() {
        return (await pool.query<PlaceRow>('select * from places order by created_at, id')).rows.map(placeOf)
      },
      async get(id) {
        const row = one((await pool.query<PlaceRow>('select * from places where id = $1', [id])).rows)
        return row && placeOf(row)
      },
      async insert(r) {
        await inTransaction(async (c) => {
          if (r.isDefault) await c.query('update places set is_default = false where is_default')
          await c.query(
            `insert into places (id, name, kind, config, secrets, enabled, is_default, max_running, gpus, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [r.id, r.name, r.kind, JSON.stringify(r.config), r.secrets, r.enabled, r.isDefault, r.maxRunning, r.gpus === null ? null : JSON.stringify(r.gpus), ts(r.createdAt), ts(r.updatedAt)],
          )
        })
      },
      async update(id, patch) {
        const { sql, values } = setClause(patch, PLACE_COLUMNS, 2)
        return inTransaction(async (c) => {
          if (patch.isDefault) await c.query('update places set is_default = false where is_default and id <> $1', [id])
          if (!sql) return one((await c.query<PlaceRow>('select * from places where id = $1', [id])).rows)
          return one((await c.query<PlaceRow>(`update places set ${sql} where id = $1 returning *`, [id, ...values])).rows)
        }).then((row) => row && placeOf(row))
      },
      async delete(id) {
        return ((await pool.query('delete from places where id = $1', [id])).rowCount ?? 0) > 0
      },
    },
    settings: {
      async get(key) {
        const row = (await pool.query<{ value: unknown }>('select value from settings where key = $1', [key])).rows[0]
        return row?.value
      },
      async set(key, value) {
        if (value === undefined) await pool.query('delete from settings where key = $1', [key])
        else await pool.query('insert into settings (key, value, updated_at) values ($1, $2, now()) on conflict (key) do update set value = excluded.value, updated_at = now()', [key, JSON.stringify(value)])
      },
    },
    async close() {
      if (opts.ownsPool) await pool.end()
    },
  }
}
