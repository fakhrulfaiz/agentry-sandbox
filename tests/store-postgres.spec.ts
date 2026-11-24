import pg from 'pg'
import { afterAll, describe } from 'vitest'
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
    await pool.query('TRUNCATE sandboxes, templates')
    return createPostgresStore(pool, { ownsPool: false })
  })
})
