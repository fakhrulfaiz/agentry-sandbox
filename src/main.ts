/**
 * Service entry point: config, Postgres (migrated), the Docker backend with
 * its network guard, startup reconciliation, the HTTP server, and the idle
 * sweep. SIGTERM stops accepting requests and closes the pool; sandboxes keep
 * running and are adopted again on the next start.
 */
import Docker from 'dockerode'
import pg from 'pg'
import { createDockerDriver } from './places/drivers/docker.ts'
import { dockerSshFactory } from './places/drivers/docker-ssh.ts'
import { e2bFactory } from './places/drivers/e2b.ts'
import { sshMachineFactory } from './places/drivers/ssh-machine.ts'
import { createPlaceRegistry } from './places/registry.ts'
import { createNetworkGuard } from './backends/network-guard.ts'
import { createEnsureImage } from './places/images.ts'
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
  const guard = createNetworkGuard(docker, config, createEnsureImage(docker))
  const local = createDockerDriver(config, guard, docker, docker, { ensure: createEnsureImage(docker) })
  const places = await createPlaceRegistry({ store, config, local, drivers: { e2b: e2bFactory(), 'docker-ssh': dockerSshFactory(config), 'ssh-machine': sshMachineFactory(config, { local: docker }) }, probeTtlMs: 30_000, probeTimeoutMs: 5_000 })
  const service = createSandboxService({ store, places, config })
  await service.loadSettings()
  await service.recoverSnapshots()

  // GPUs are looked for once here (not per request) and remembered.
  const found = await local.discoverGpus?.().catch(() => [])
  if (found && found.length > 0) log('gpus', found.map((g) => g.name))
  const available = await local.probe()
  log(available.ok ? `docker ${available.version}` : `docker unavailable: ${available.reason}`)
  // Reconciles every place that answers; one that does not is skipped.
  log('reconciled', await service.reconcile())
  if (available.ok) {
    // Rules left by crashed or removed sandboxes would block a later container that reuses the IP.
    const active = (await docker.listContainers({ all: true, filters: { label: ['agentry.managed=true'] } })).map((c) => c.Id)
    await guard.prune(active).catch((e: unknown) => log('rule prune failed', String(e)))
  }

  const server = createServer({ config, service, store, places })
  await new Promise<void>((resolve) => server.listen(config.port, host, resolve))
  if (config.adminKeyHashes.length > 0) log(`admin page on http://${host}:${String(config.port)}/admin`)
  log(`listening on http://${host}:${String(config.port)} (envd reach: ${config.envdReach}, runtime: ${config.runtime}, egress guard: ${config.egress ? 'on' : 'off'}, limits: ${JSON.stringify({ ...service.limits(), owners: Object.keys(service.limits().owners).length })})`)

  const sweep = setInterval(() => {
    void service
      .sweepIdle()
      .then((stopped) => {
        if (stopped.length > 0) log('stopped idle sandboxes', stopped)
      })
      .catch((e: unknown) => log('idle sweep failed', String(e)))
    void service
      .sweepSnapshots()
      .then((gone) => {
        if (gone.length > 0) log('removed expired snapshots', gone)
      })
      .catch((e: unknown) => log('snapshot sweep failed', String(e)))
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
