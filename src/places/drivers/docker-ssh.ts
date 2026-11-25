/**
 * Docker on a remote host over SSH. The Docker driver, with its API client
 * speaking through `docker system dial-stdio` over SSH, the egress guard
 * running through that same client, envd published on the remote host's
 * 127.0.0.1 only, and an SSH tunnel from this service to that port.
 *
 * Config `{ target: 'ssh://user@host[:port]', host_key }`, secrets
 * `{ privateKey }`. Without `host_key` the driver only answers `probe`
 * (and reports the key it saw); nothing else runs over an unpinned connection.
 */
import Docker from 'dockerode'
import type { SandboxConfig } from '../../config.ts'
import { createNetworkGuard } from '../../backends/network-guard.ts'
import { HostKeyChangedError, type Driver } from '../driver.ts'
import type { DriverFactory } from '../registry.ts'
import { createTunnels, parseSshTarget, sshConnectOptions } from '../ssh.ts'
import { createDockerDriver } from './docker.ts'

const DOCKER_TIMEOUT_MS = 60_000

export function createDockerSshDriver(baseConfig: SandboxConfig, place: { target: string; hostKey?: string; privateKey: string }): Driver {
  const config: SandboxConfig = { ...baseConfig, envdReach: 'loopback' }
  const target = parseSshTarget(place.target)
  const pinned = place.hostKey
  let changed = false
  let observed: string | undefined
  const hooks = {
    seen: (fp: string) => {
      observed = fp
      if (fp === pinned) changed = false
    },
    mismatch: () => {
      changed = true
    },
  }
  const sshOptions = () => sshConnectOptions({ privateKey: place.privateKey, pinned, hooks })
  const dockerOver = (timeout: number | undefined) => new Docker({ protocol: 'ssh', host: target.host, port: target.port, username: target.username, sshOptions: sshOptions(), ...(timeout === undefined ? {} : { timeout }) })
  const client = dockerOver(DOCKER_TIMEOUT_MS)
  const puller = dockerOver(undefined)
  const tunnels = pinned ? createTunnels({ target, privateKey: place.privateKey, hostKey: pinned }) : undefined

  const inner = createDockerDriver(config, createNetworkGuard(client, config), client, puller, {
    kind: 'docker-ssh',
    async reach(hostPort) {
      if (!tunnels) throw new Error('the host key is not pinned')
      const tunnel = await tunnels.open(hostPort)
      return { baseUrl: `http://127.0.0.1:${String(tunnel.localPort)}`, release: () => tunnel.close() }
    },
  })

  const keyError = (e: unknown): unknown => (changed || e instanceof HostKeyChangedError ? new HostKeyChangedError('the host key changed') : e)

  const driver: Driver = {
    ...inner,
    async probe() {
      const r = await inner.probe()
      if (!r.ok && changed) return { ok: false, reason: 'host key changed' }
      return r
    },
    observedHostKey: () => observed,
    async close() {
      await tunnels?.closeAll()
    },
  }
  // Everything but probe/close runs only on a pinned connection, and a host key mismatch surfaces as HostKeyChangedError.
  for (const name of ['create', 'start', 'stop', 'destroy', 'status', 'envdEndpoint', 'listManaged', 'maintain', 'releaseOwner', 'describeImage'] as const) {
    const fn = inner[name] as ((...a: unknown[]) => Promise<unknown>) | undefined
    if (!fn) continue
    ;(driver as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      if (!pinned) throw new Error('the host key is not pinned')
      try {
        return await fn(...args)
      } catch (e) {
        throw keyError(e)
      }
    }
  }
  return driver
}

/** Registry factory for kind `docker-ssh`. */
export function dockerSshFactory(config: SandboxConfig): DriverFactory {
  return (record, secrets) => {
    const target = record.config.target
    if (typeof target !== 'string') throw new Error('target is required')
    parseSshTarget(target)
    if (!secrets.privateKey) throw new Error('privateKey is required')
    const hostKey = record.config.host_key
    return createDockerSshDriver(config, { target, privateKey: secrets.privateKey, ...(typeof hostKey === 'string' && hostKey ? { hostKey } : {}) })
  }
}
