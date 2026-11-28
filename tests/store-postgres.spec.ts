import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { migrate } from '../src/store/migrate.ts'
import { createPostgresStore } from '../src/store/postgres.ts'
import { storeContract } from './store-contract.ts'

const url = process.env.AGENTRY_SANDBOX_TEST_DATABASE_URL
const pools: pg.Pool[] = []

describe.skipIf(!url)('postgres', () => {
  afterAll(async () => {
    for (const p of pools) await p.end()
  })
  storeContract('postgres store', async () => {
    const pool = new pg.Pool({ connectionString: url })
    pools.push(pool)
    await migrate(pool)
    // Test database only: start every case from empty tables.
    await pool.query('TRUNCATE sandboxes, templates, places, snapshots')
    return createPostgresStore(pool, { ownsPool: false })
  })
  it('migration 0003 maps backend docker to local', async () => {
    const pool = new pg.Pool({ connectionString: url })
    pools.push(pool)
    await migrate(pool)
    await pool.query('TRUNCATE sandboxes')
    // Re-run 0003 over a pre-0003 row (the migration is idempotent).
    await pool.query("delete from schema_migrations where name = '0003_places.sql'")
    await pool.query(
      "insert into sandboxes (id, owner, name, backend, template, state, handle, created_at) values ('sbx_mig', 'alice', 'b', 'docker', '{}', 'stopped', '{}', now())",
    )
    expect(await migrate(pool)).toEqual(['0003_places.sql'])
    expect((await pool.query<{ backend: string }>("select backend from sandboxes where id = 'sbx_mig'")).rows[0]?.backend).toBe('local')
    await pool.query('TRUNCATE sandboxes')
  })
})
