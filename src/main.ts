/**
 * Service entry point: config, Postgres (migrated), the Docker backend with
 * its network guard, startup reconciliation, the HTTP server, and the idle
 * sweep. SIGTERM stops accepting requests and closes the pool; sandboxes keep
 * running and are adopted again on the next start.
 */
import Docker from 'dockerode'
import pg from 'pg'
import { createDockerBackend } from './backends/docker.ts'
import { createNetworkGuard } from './backends/network-guard.ts'
import { ConfigError, loadConfig } from './config.ts'
import { createServer } from './http/server.ts'
import { createSandboxService } from './sandboxes.ts'
import { migrate } from './store/migrate.ts'
import { createPostgresStore } from './store/postgres.ts'

const log = (msg: string, extra?: unknown) => console.log(`[agentry-sandbox] ${msg}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`)

async function main(): Promise<void> {
  const config = loadConfig(process.env)
  const host = process.env.AGENTRY_SANDBOX_HOST?.trim() || '127.0.0.1'
  const pool = new pg.Pool({ connectionString: config.databaseUrl })
  const applied = await migrate(pool)
  if (applied.length > 0) log('migrated', applied)
  const store = createPostgresStore(pool)
  const docker = new Docker()
  const guard = createNetworkGuard(docker, config)
  const backend = createDockerBackend(config, guard)
  const service = createSandboxService({ store, backend, config })

  const available = await backend.available()
  log(available.ok ? `docker ${available.version}` : `docker unavailable: ${available.reason}`)
  if (available.ok) {
    log('reconciled', await service.reconcile())
    // Rules left by crashed or removed sandboxes would block a later container that reuses the IP.
    const active = (await docker.listContainers({ all: true, filters: { label: ['agentry.managed=true'] } })).map((c) => c.Id)
    await guard.prune(active).catch((e: unknown) => log('rule prune failed', String(e)))
  }

  const server = createServer({ config, service, store, backend })
  await new Promise<void>((resolve) => server.listen(config.port, host, resolve))
  log(`listening on http://${host}:${String(config.port)} (envd reach: ${config.envdReach}, runtime: ${config.runtime}, egress guard: ${config.egress ? 'on' : 'off'}, limits: ${JSON.stringify({ ...config.limits, owners: Object.keys(config.limits.owners).length })})`)

  const sweep = setInterval(() => {
    void service
      .sweepIdle()
      .then((stopped) => {
        if (stopped.length > 0) log('stopped idle sandboxes', stopped)
      })
      .catch((e: unknown) => log('idle sweep failed', String(e)))
  }, 60_000)

  const shutdown = () => {
    log('shutting down')
    clearInterval(sweep)
    server.close(() => void store.close().then(() => process.exit(0)))
    setTimeout(() => process.exit(0), 10_000).unref()
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((e: unknown) => {
  console.error(e instanceof ConfigError ? `[agentry-sandbox] config: ${e.message}` : e)
  process.exit(1)
})
