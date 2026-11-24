/** Forward-only SQL migrations from `migrations/NNNN_name.sql`, applied once each in order. */
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type pg from 'pg'

const DIR = fileURLToPath(new URL('../../migrations/', import.meta.url))

export async function migrate(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect()
  try {
    // One migrator at a time, even with several service processes starting together.
    await client.query('select pg_advisory_lock(7310421)')
    await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())')
    const done = new Set((await client.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name))
    const files = (await readdir(DIR)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()
    const applied: string[] = []
    for (const file of files) {
      if (done.has(file)) continue
      const sql = await readFile(`${DIR}${file}`, 'utf8')
      await client.query('begin')
      try {
        await client.query(sql)
        await client.query('insert into schema_migrations (name) values ($1)', [file])
        await client.query('commit')
        applied.push(file)
      } catch (error) {
        await client.query('rollback')
        throw error
      }
    }
    return applied
  } finally {
    await client.query('select pg_advisory_unlock(7310421)').catch(() => {})
    client.release()
  }
}
