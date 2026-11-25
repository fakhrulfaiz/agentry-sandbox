import fs from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { sq } from '../src/envd/run.ts'
import { loadConfig } from '../src/config.ts'
import { HostKeyChangedError } from '../src/places/driver.ts'
import { createSshMachineDriver, portBase } from '../src/places/drivers/ssh-machine.ts'
import { fpOf, hostKey, otherHostKey, startMachine, userKey, type Machine } from './support/fake-machine.ts'

const config = loadConfig({ AGENTRY_SANDBOX_DATABASE_URL: 'postgres://x@localhost/x', AGENTRY_SANDBOX_API_KEYS: `sha256:${'a'.repeat(64)}`, AGENTRY_SANDBOX_SECRET: 's'.repeat(32), AGENTRY_SANDBOX_START_TIMEOUT_MS: '5000' })
const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function setup(tweak: (m: Machine) => void = () => {}, hostKeyPin = fpOf(hostKey.public)) {
  const machine = await startMachine()
  tweak(machine)
  const platforms: string[] = []
  const driver = createSshMachineDriver(config, { target: `ssh://deploy@127.0.0.1:${String(machine.port)}`, privateKey: userKey.private, hostKey: hostKeyPin }, { envdBinary: async (p) => { platforms.push(p); return Buffer.from(`envd binary for ${p}`) } })
  cleanups.push(() => machine.close(), () => driver.close?.())
  const ws = (name: string) => `${machine.home}/work/${name}`
  return { machine, driver, platforms, ws }
}

const binOf = (m: Machine, arch = 'amd64') => `${m.home}/.agentry/bin/envd-envd-v0.6.13-${arch}`
const idx = (log: string[], needle: string) => log.findIndex((c) => c.includes(needle))

describe('ssh-machine driver', () => {
  it('probe without sudo reports why', async () => {
    const { machine, driver } = await setup((m) => { m.sudo = false })
    expect(await driver.probe()).toEqual({ ok: false, reason: 'passwordless sudo is required for deploy' })
    await expect(driver.create('sbx_a', 'o', { workspacePath: `${machine.home}/w` }, { gpuIds: [] })).rejects.toThrow(/passwordless sudo is required for deploy/u)
    expect(machine.uploads).toEqual([])
    expect(machine.procs.size).toBe(0)
  })

  it('probe reports GPUs from nvidia-smi', async () => {
    const { driver } = await setup((m) => { m.gpus = '0, GPU-aaa, NVIDIA A100\n1, GPU-bbb, NVIDIA A100\n' })
    const r = await driver.probe()
    expect(r).toMatchObject({ ok: true, gpus: [{ index: 0, uuid: 'GPU-aaa', name: 'NVIDIA A100' }, { index: 1, uuid: 'GPU-bbb', name: 'NVIDIA A100' }] })
    expect(await driver.discoverGpus?.()).toHaveLength(2)
    const none = await setup()
    expect(await none.driver.probe()).toMatchObject({ ok: true, gpus: [] })
  })

  it('create uploads envd once per arch and starts it with sudo on a free port', async () => {
    const { machine, driver, platforms, ws } = await setup((m) => { m.busy.add(portBase('sbx_a')) })
    const h = await driver.create('sbx_a', 'owner1', { workspacePath: ws('a') }, { gpuIds: [] })
    const bin = binOf(machine)
    expect(machine.uploads.filter((u) => u.startsWith(`${bin}.`))).toHaveLength(1)
    expect(fs.readFileSync(bin, 'utf8')).toBe('envd binary for linux/amd64')
    expect(platforms).toEqual(['linux/amd64'])
    // The busy base port is skipped; the port is recorded.
    expect(Number(h.port)).toBe(portBase('sbx_a') + 1)
    const [proc] = [...machine.procs.values()]
    expect(proc!.cmdline.join(' ')).toBe(`sudo -n ${bin} --isnotfc --no-cgroups --port ${h.port!}`)
    expect(machine.log.some((c) => c.startsWith('sh -c ') && c.includes(sq(`sudo -n '${bin}' --isnotfc --no-cgroups --port ${h.port!}`).slice(1, -1)))).toBe(true)
    const meta = `${machine.home}/.agentry/sandboxes/sbx_a`
    expect(JSON.parse(fs.readFileSync(`${meta}/meta.json`, 'utf8'))).toEqual({ id: 'sbx_a', owner: 'owner1', workspace: ws('a'), port: Number(h.port) })
    expect(fs.existsSync(`${meta}/envd.pid`)).toBe(true)
    expect(fs.existsSync(ws('a'))).toBe(true)
    expect(h).toMatchObject({ id: 'sbx_a', workspace: ws('a') })
    expect(await driver.status(h)).toBe('running')
    expect(await driver.envdEndpoint(h).then((e) => { e.release?.(); return e.baseUrl })).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)

    // A second sandbox on the same architecture uploads nothing.
    await driver.create('sbx_b', 'owner1', { workspacePath: ws('b') }, { gpuIds: [] })
    expect(machine.uploads.filter((u) => u.startsWith(bin))).toHaveLength(1)

    // Another architecture gets its own envd, loaded for that platform.
    const arm = await setup((m) => { m.uname = 'aarch64' })
    await arm.driver.create('sbx_c', 'o', { workspacePath: arm.ws('c') }, { gpuIds: [] })
    expect(arm.platforms).toEqual(['linux/arm64'])
    expect(fs.existsSync(binOf(arm.machine, 'arm64'))).toBe(true)
    expect(await arm.driver.dshRuntime?.()).toMatchObject({ arch: 'arm64' }) // DSH's runtime is read for the machine's architecture
  })

  it('refuses an unsupported architecture', async () => {
    const { machine, driver, ws } = await setup((m) => { m.uname = 'riscv64' })
    expect(await driver.probe()).toEqual({ ok: false, reason: 'unsupported architecture riscv64' })
    await expect(driver.create('sbx_a', 'o', { workspacePath: ws('a') }, { gpuIds: [] })).rejects.toThrow(/unsupported architecture riscv64/u)
    expect(machine.procs.size).toBe(0)
  })

  it('start after a reboot relaunches envd', async () => {
    const { machine, driver, ws } = await setup()
    const h = await driver.create('sbx_a', 'o', { workspacePath: ws('a') }, { gpuIds: [] })
    fs.writeFileSync(`${ws('a')}/keep.txt`, 'mine')
    await machine.reboot()
    expect(machine.rules.size).toBe(0)
    expect(await driver.status(h)).toBe('stopped')
    const h2 = await driver.start('sbx_a', h, {}, { gpuIds: [] })
    expect(await driver.status(h2)).toBe('running')
    expect(h2.port).toBe(h.port)
    expect(machine.procs.size).toBe(1)
    expect(machine.rules.size).toBe(2)
    expect(fs.readFileSync(`${ws('a')}/keep.txt`, 'utf8')).toBe('mine')
    // A start on a healthy sandbox starts nothing new.
    const before = [...machine.procs.keys()]
    await driver.start('sbx_a', h2, {}, { gpuIds: [] })
    expect([...machine.procs.keys()]).toEqual(before)
  })

  it('start picks a new port when the recorded one is taken after a reboot', async () => {
    const { machine, driver, ws } = await setup()
    const h = await driver.create('sbx_a', 'o', { workspacePath: ws('a') }, { gpuIds: [] })
    await machine.reboot()
    machine.busy.add(Number(h.port))
    const h2 = await driver.start('sbx_a', h, {}, { gpuIds: [] })
    expect(Number(h2.port)).toBe(Number(h.port) + 1)
    expect(JSON.parse(fs.readFileSync(`${machine.home}/.agentry/sandboxes/sbx_a/meta.json`, 'utf8')).port).toBe(Number(h2.port))
    expect(await driver.status(h2)).toBe('running')
  })

  it('destroy refuses an unsafe workspace path', async () => {
    const { machine, driver, ws } = await setup()
    const h = await driver.create('sbx_a', 'o', { workspacePath: ws('a') }, { gpuIds: [] })
    for (const bad of ['/', '', 'relative', '/etc', machine.home, '/a/../b']) {
      await expect(driver.destroy('sbx_a', { ...h, workspace: bad }, { keepWorkspace: false })).rejects.toThrow(/refusing/u)
    }
    expect(machine.removed).toEqual([])
    expect(machine.rmOutside).toEqual([])
    expect(machine.procs.size).toBe(1)
    expect(fs.existsSync(`${machine.home}/.agentry/sandboxes/sbx_a`)).toBe(true)
    expect(fs.existsSync(ws('a'))).toBe(true)
  })

  it('destroy removes only the recorded workspace and the sandbox dir', async () => {
    const { machine, driver, ws } = await setup()
    const a = await driver.create('sbx_a', 'o', { workspacePath: ws('a') }, { gpuIds: [] })
    await driver.create('sbx_b', 'o', { workspacePath: ws('b') }, { gpuIds: [] })
    fs.writeFileSync(`${ws('a')}/f`, 'x')
    fs.mkdirSync(`${machine.home}/other`)
    fs.writeFileSync(`${machine.home}/other/precious`, 'x')
    await driver.destroy('sbx_a', a, { keepWorkspace: false })
    expect(machine.removed.sort()).toEqual([ws('a'), `${machine.home}/.agentry/sandboxes/sbx_a`].sort())
    expect(fs.existsSync(ws('a'))).toBe(false)
    expect(fs.existsSync(`${machine.home}/.agentry/sandboxes/sbx_a`)).toBe(false)
    expect(fs.existsSync(`${machine.home}/other/precious`)).toBe(true)
    expect(fs.existsSync(binOf(machine))).toBe(true)
    expect(fs.existsSync(ws('b'))).toBe(true)
    expect(machine.procs.size).toBe(1)
    expect(machine.rules.size).toBe(2) // sbx_b's pair stays
    expect(machine.rmOutside).toEqual([])
    // Keeping the workspace removes only the sandbox dir; an empty handle works from meta.json.
    const b = await driver.listManaged()
    await driver.destroy('sbx_b', {}, { keepWorkspace: true })
    expect(b.map((m) => m.id)).toEqual(['sbx_b'])
    expect(fs.existsSync(ws('b'))).toBe(true)
    expect(fs.existsSync(`${machine.home}/.agentry/sandboxes/sbx_b`)).toBe(false)
    expect(machine.procs.size).toBe(0)
  })

  it('start adds the loopback-only rules before envd and refuses to start envd when they fail', async () => {
    const { machine, driver, ws } = await setup()
    const h = await driver.create('sbx_a', 'o', { workspacePath: ws('a') }, { gpuIds: [] })
    const rule = (tool: string) => `${tool} INPUT -p tcp --dport ${h.port!} ! -i lo -m comment --comment agentry-sbx_a -j DROP`
    expect([...machine.rules].sort()).toEqual([rule('ip6tables'), rule('iptables')])
    const launch = idx(machine.log, 'nohup')
    expect(idx(machine.log, 'iptables -I')).toBeGreaterThan(-1)
    expect(idx(machine.log, 'iptables -I')).toBeLessThan(launch)
    expect(idx(machine.log, 'ip6tables -I')).toBeLessThan(launch)

    // No iptables: nothing is started, and the error says why; the half-made sandbox is cleaned up.
    const no = await setup((m) => { m.iptables = false })
    await expect(no.driver.create('sbx_n', 'o', { workspacePath: no.ws('n') }, { gpuIds: [] })).rejects.toThrow(/cannot restrict envd to loopback on 127\.0\.0\.1: .*iptables.*not found/u)
    expect(no.machine.procs.size).toBe(0)
    expect(no.machine.log.some((c) => c.includes('nohup'))).toBe(false)
    expect(fs.existsSync(`${no.machine.home}/.agentry/sandboxes/sbx_n`)).toBe(false)
    expect(fs.existsSync(no.ws('n'))).toBe(false)

    // A later start on an existing sandbox fails closed too.
    await machine.reboot()
    machine.ip6tables = false
    await expect(driver.start('sbx_a', h, {}, { gpuIds: [] })).rejects.toThrow(/cannot restrict envd to loopback/u)
    expect(machine.procs.size).toBe(0)
    // ... unless the machine has no IPv6 at all.
    machine.ipv6 = false
    await driver.start('sbx_a', h, {}, { gpuIds: [] })
    expect(machine.procs.size).toBe(1)
  })

  it('stop removes the rules', async () => {
    const { machine, driver, ws } = await setup()
    const h = await driver.create('sbx_a', 'o', { workspacePath: ws('a') }, { gpuIds: [] })
    expect(machine.rules.size).toBe(2)
    await driver.stop(h)
    expect(machine.rules.size).toBe(0)
    expect(machine.procs.size).toBe(0)
    expect(await driver.status(h)).toBe('stopped')
    expect(fs.existsSync(ws('a'))).toBe(true)
    const again = await driver.start('sbx_a', h, {}, { gpuIds: [] })
    expect(await driver.status(again)).toBe('running')
  })

  it('two sandboxes on one machine are independent', async () => {
    const { machine, driver, ws } = await setup()
    const a = await driver.create('sbx_a', 'o1', { workspacePath: ws('a') }, { gpuIds: [] })
    const b = await driver.create('sbx_b', 'o2', { workspacePath: ws('b') }, { gpuIds: [] })
    expect(a.port).not.toBe(b.port)
    const pids = fs.readdirSync(`${machine.home}/.agentry/sandboxes`).map((d) => fs.readFileSync(`${machine.home}/.agentry/sandboxes/${d}/envd.pid`, 'utf8').trim())
    expect(new Set(pids).size).toBe(2)
    expect((await driver.listManaged()).map((m) => [m.id, m.owner]).sort()).toEqual([['sbx_a', 'o1'], ['sbx_b', 'o2']])
    await driver.stop(a)
    expect(await driver.status(a)).toBe('stopped')
    expect(await driver.status(b)).toBe('running')
    expect(machine.procs.size).toBe(1)
    expect([...machine.rules].every((r) => r.includes('agentry-sbx_b'))).toBe(true)
    // The same workspace twice would let one destroy the other's files.
    await expect(driver.create('sbx_c', 'o', { workspacePath: ws('b') }, { gpuIds: [] })).rejects.toThrow(/already used by sandbox sbx_b/u)
    expect(fs.existsSync(ws('b'))).toBe(true)
    expect(await driver.status({ id: 'sbx_gone' })).toBe('missing')
  })

  it('the relay maps agent to the login user', () => {
    const driver = createSshMachineDriver(config, { target: 'ssh://deploy@127.0.0.1:22', privateKey: userKey.private, hostKey: fpOf(hostKey.public) })
    expect(driver.agentUser).toBe('deploy')
    expect(driver.envdUser?.('agent')).toBe('deploy')
    expect(driver.envdUser?.('root')).toBe('root')
    expect(driver.envdUser?.('bob')).toBe('bob')
  })

  it('GPU assignment reaches CUDA_VISIBLE_DEVICES', async () => {
    const { driver, ws } = await setup()
    const h = await driver.create('sbx_a', 'o', { workspacePath: ws('a') }, { gpuIds: ['GPU-aaa', 'GPU-bbb'] })
    expect(h.gpuIds).toBe('GPU-aaa,GPU-bbb')
    expect(driver.envdEnv?.(h)).toEqual({ CUDA_VISIBLE_DEVICES: 'GPU-aaa,GPU-bbb' })
    expect(driver.envdEnv?.({})).toEqual({})
    const s = await driver.start('sbx_a', h, {}, { gpuIds: ['GPU-bbb'] })
    expect(driver.envdEnv?.(s)).toEqual({ CUDA_VISIBLE_DEVICES: 'GPU-bbb' })
  })

  it('a changed host key stops every call before anything is sent', async () => {
    const { machine, driver, ws } = await setup(() => {}, fpOf(otherHostKey.public))
    expect(await driver.probe()).toEqual({ ok: false, reason: 'host key changed', hostKeyChanged: true })
    await expect(driver.create('sbx_a', 'o', { workspacePath: ws('a') }, { gpuIds: [] })).rejects.toBeInstanceOf(HostKeyChangedError)
    expect(machine.log).toEqual([])
  })
})
