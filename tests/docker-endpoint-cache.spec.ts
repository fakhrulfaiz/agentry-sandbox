import type Docker from 'dockerode'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { createPassthroughNetworkGuard, type Handle } from '../src/places/driver.ts'
import { createDockerDriver } from '../src/places/drivers/docker.ts'

const config = (over: Record<string, unknown> = {}) => ({
  ...loadConfig({ AGENTRY_SANDBOX_DATABASE_URL: 'postgres://x@localhost/x', AGENTRY_SANDBOX_API_KEYS: `sha256:${'a'.repeat(64)}`, AGENTRY_SANDBOX_SECRET: 's'.repeat(32) }),
  ...over,
})

const handle: Handle = { containerId: 'container-1' }

function stubClient(inspect: () => Promise<unknown>) {
  return {
    getContainer: () => ({
      inspect,
      stop: async () => {},
      remove: async () => {},
    }),
    getVolume: () => ({ remove: async () => {} }),
  } as unknown as Docker
}

/** The relay and the bootstrap both call `release` after a request; that must not tear down a shared tunnel. */
describe('docker envd endpoint reuse', () => {
  it('resolves the endpoint once per container and keeps its tunnel across requests', async () => {
    let inspects = 0
    let reaches = 0
    let releases = 0
    const client = stubClient(async () => {
      inspects++
      return { NetworkSettings: { Ports: { '49983/tcp': [{ HostIp: '127.0.0.1', HostPort: '51234' }] } } }
    })
    const driver = createDockerDriver(config({ envdReach: 'loopback' }), createPassthroughNetworkGuard(), client, client, {
      reach: async () => {
        reaches++
        return { baseUrl: 'http://127.0.0.1:51234', release: () => { releases++ } }
      },
    })

    const first = await driver.envdEndpoint(handle)
    const second = await driver.envdEndpoint(handle)
    first.release?.()
    const third = await driver.envdEndpoint(handle)

    expect([first.baseUrl, second.baseUrl, third.baseUrl]).toEqual(['http://127.0.0.1:51234', 'http://127.0.0.1:51234', 'http://127.0.0.1:51234'])
    expect(inspects).toBe(1)
    expect(reaches).toBe(1)
    expect(releases).toBe(0)
  })

  it('drops the cached endpoint when its container stops', async () => {
    let inspects = 0
    const client = stubClient(async () => {
      inspects++
      return { NetworkSettings: { Ports: { '49983/tcp': [{ HostIp: '127.0.0.1', HostPort: '51234' }] } } }
    })
    const driver = createDockerDriver(config({ envdReach: 'loopback' }), createPassthroughNetworkGuard(), client, client)

    await driver.envdEndpoint(handle)
    await driver.stop(handle)
    await driver.envdEndpoint(handle)

    expect(inspects).toBe(2)
  })

  it('drops the cached endpoint when its container is destroyed', async () => {
    let port = '51234'
    const client = stubClient(async () => ({ NetworkSettings: { Ports: { '49983/tcp': [{ HostIp: '127.0.0.1', HostPort: port }] } } }))
    const driver = createDockerDriver(config({ envdReach: 'loopback' }), createPassthroughNetworkGuard(), client, client)

    const before = await driver.envdEndpoint(handle)
    await driver.destroy('sandbox-1', handle, { keepWorkspace: false })
    port = '51235'
    const after = await driver.envdEndpoint(handle)

    expect(before.baseUrl).toBe('http://127.0.0.1:51234')
    expect(after.baseUrl).toBe('http://127.0.0.1:51235')
  })

  it('releases cached reaches and forgets them when the driver closes', async () => {
    let port = '51234'
    let releases = 0
    const client = stubClient(async () => ({ NetworkSettings: { Ports: { '49983/tcp': [{ HostIp: '127.0.0.1', HostPort: port }] } } }))
    const driver = createDockerDriver(config({ envdReach: 'loopback' }), createPassthroughNetworkGuard(), client, client, {
      reach: async () => ({ baseUrl: `http://127.0.0.1:${port}`, release: () => { releases++ } }),
    })

    expect((await driver.envdEndpoint(handle)).baseUrl).toBe('http://127.0.0.1:51234')
    await driver.close?.()
    expect(releases).toBe(1)
    port = '51235'
    expect((await driver.envdEndpoint(handle)).baseUrl).toBe('http://127.0.0.1:51235')
  })

  it('trusts a recent running status instead of inspecting Docker on every relay request', async () => {
    let inspects = 0
    const client = stubClient(async () => {
      inspects++
      return { State: { Running: true }, NetworkSettings: { Ports: { '49983/tcp': [{ HostIp: '127.0.0.1', HostPort: '51234' }] } } }
    })
    const driver = createDockerDriver(config(), createPassthroughNetworkGuard(), client, client)

    expect(await driver.status(handle)).toBe('running')
    expect(await driver.status(handle)).toBe('running')

    expect(inspects).toBe(1)
  })
})
