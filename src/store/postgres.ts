/** Postgres Store: the `sandboxes` and `templates` tables from `migrations/`. */
import type pg from 'pg'
import type { SandboxPatch, SandboxRecord, Store, TemplatePatch, TemplateRecord } from './types.ts'

interface SandboxRow {
  id: string
  owner: string
  name: string
  backend: string
  template: SandboxRecord['template']
  template_id: string | null
  state: SandboxRecord['state']
  handle: Record<string, string>
  error: string | null
  created_at: Date
  started_at: Date | null
  last_used_at: Date | null
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
  error: r.error,
  createdAt: r.created_at.getTime(),
  startedAt: ms(r.started_at),
  lastUsedAt: ms(r.last_used_at),
})
const templateOf = (r: TemplateRow): TemplateRecord => ({ id: r.id, owner: r.owner, name: r.name, spec: r.spec, createdAt: r.created_at.getTime(), updatedAt: r.updated_at.getTime() })

type Column = [string, (v: unknown) => unknown]

/** Patchable sandbox fields → column and conversion. */
const SANDBOX_COLUMNS: Record<keyof SandboxPatch, Column> = {
  name: ['name', (v) => v],
  template: ['template', (v) => JSON.stringify(v)],
  state: ['state', (v) => v],
  handle: ['handle', (v) => JSON.stringify(v)],
  error: ['error', (v) => v],
  startedAt: ['started_at', (v) => ts((v as number | null) ?? null)],
  lastUsedAt: ['last_used_at', (v) => ts((v as number | null) ?? null)],
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
  return {
    sandboxes: {
      async insert(r) {
        await pool.query(
          `insert into sandboxes (id, owner, name, backend, template, template_id, state, handle, error, created_at, started_at, last_used_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [r.id, r.owner, r.name, r.backend, JSON.stringify(r.template), r.templateId, r.state, JSON.stringify(r.handle), r.error, ts(r.createdAt), ts(r.startedAt), ts(r.lastUsedAt)],
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
    async close() {
      if (opts.ownsPool) await pool.end()
    },
  }
}
