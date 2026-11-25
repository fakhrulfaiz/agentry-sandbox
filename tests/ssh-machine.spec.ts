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
  const ws = (name: string) => `${machine.home}/work/sandbox-${name}`
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
    expect(proc!.cmdline.join(' ')).toBe(`${bin} --isnotfc --no-cgroups --port ${h.port!}`)
    expect(machine.log.some((c) => c.startsWith('sh -c ') && c.includes('sudo -n setsid sh -c') && c.includes(bin) && c.includes(`--port ${h.port!}`))).toBe(true)
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
    expect(machine.rules.size).toBe(4)
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

  it('adopts an empty existing workspace, refuses a non-empty one', async () => {
    const { machine, driver, ws } = await setup()
    fs.mkdirSync(ws('e'), { recursive: true })
    const h = await driver.create('sbx_e', 'o', { workspacePath: ws('e') }, { gpuIds: [] })
    expect(h.workspace).toBe(ws('e'))
    expect(fs.readFileSync(`${ws('e')}/.agentry-sandbox`, 'utf8').trim()).toBe('sbx_e')
    fs.mkdirSync(ws('n'), { recursive: true })
    fs.writeFileSync(`${ws('n')}/precious`, 'x')
    await expect(driver.create('sbx_n', 'o', { workspacePath: ws('n') }, { gpuIds: [] })).rejects.toThrow(/already exists/u)
    fs.writeFileSync(ws('f'), 'x')
    await expect(driver.create('sbx_f', 'o', { workspacePath: ws('f') }, { gpuIds: [] })).rejects.toThrow(/already exists/u)
    fs.mkdirSync(`${machine.home}/target`)
    fs.symlinkSync(`${machine.home}/target`, ws('l'))
    await expect(driver.create('sbx_l', 'o', { workspacePath: ws('l') }, { gpuIds: [] })).rejects.toThrow(/already exists/u)
    expect(fs.existsSync(`${ws('n')}/precious`)).toBe(true)
    expect(fs.readdirSync(`${machine.home}/target`)).toEqual([])
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
    expect(machine.rules.size).toBe(4) // sbx_b's rules stay
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
    const owner = (tool: string) => `${tool} OUTPUT -o lo -p tcp --dport ${h.port!} -m owner ! --uid-owner 1000 -m comment --comment agentry-sbx_a -j REJECT`
    expect([...machine.rules].sort()).toEqual([rule('ip6tables'), rule('iptables'), owner('ip6tables'), owner('iptables')].sort())
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
    expect(machine.rules.size).toBe(4)
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

  describe('final review fixes', () => {
    const sandboxes = (m: Machine) => `${m.home}/.agentry/sandboxes`

    it('M1: a requiretty box is told to turn requiretty off', async () => {
      const { driver } = await setup((m) => { m.sudo = false; m.sudoErr = 'sudo: sorry, you must have a tty to run sudo' })
      expect(await driver.probe()).toEqual({ ok: false, reason: 'sudo needs a terminal for deploy (turn off requiretty for this user in sudoers)' })
    })

    it('I1: a pre-existing workspace is refused, untouched, and never deleted', async () => {
      const { machine, driver, ws } = await setup()
      fs.mkdirSync(ws('data'), { recursive: true })
      fs.writeFileSync(`${ws('data')}/precious`, 'x')
      await expect(driver.create('sbx_a', 'o', { workspacePath: ws('data') }, { gpuIds: [] })).rejects.toThrow(/already exists/u)
      expect(fs.readFileSync(`${ws('data')}/precious`, 'utf8')).toBe('x')
      expect(machine.log.some((c) => c.includes('chown'))).toBe(false)
      expect(machine.removed).toEqual([`${sandboxes(machine)}/sbx_a`]) // only its own (empty) sandbox directory
      expect(machine.procs.size).toBe(0)
      expect(fs.existsSync(`${sandboxes(machine)}/sbx_a`)).toBe(false)
    })

    it('I1: destroy deletes only a sandbox-named workspace whose marker holds its id', async () => {
      const { machine, driver, ws } = await setup()
      const own = await driver.create('sbx_a', 'o', { workspacePath: ws('a') }, { gpuIds: [] })
      expect(fs.readFileSync(`${ws('a')}/.agentry-sandbox`, 'utf8').trim()).toBe('sbx_a')
      // The marker names someone else: left alone, the sandbox itself still goes.
      fs.writeFileSync(`${ws('a')}/.agentry-sandbox`, 'sbx_other\n')
      await driver.destroy('sbx_a', own, { keepWorkspace: false })
      expect(fs.existsSync(ws('a'))).toBe(true)
      expect(fs.existsSync(`${sandboxes(machine)}/sbx_a`)).toBe(false)
      expect(machine.removed).toEqual([`${sandboxes(machine)}/sbx_a`])
      // A workspace not named sandbox-... (the default /workspace style) is never deleted either.
      const plain = `${machine.home}/work/data`
      const b = await driver.create('sbx_b', 'o', { workspacePath: plain }, { gpuIds: [] })
      await driver.destroy('sbx_b', b, { keepWorkspace: false })
      expect(fs.existsSync(plain)).toBe(true)
      expect(machine.removed).not.toContain(plain)
      // The normal case still removes it.
      const c = await driver.create('sbx_c', 'o', { workspacePath: ws('c') }, { gpuIds: [] })
      await driver.destroy('sbx_c', c, { keepWorkspace: false })
      expect(fs.existsSync(ws('c'))).toBe(false)
    })

    it('I2: the recorded pid is envd itself, and stop still finds it after an envd upgrade', async () => {
      const { machine, driver, ws } = await setup()
      const h = await driver.create('sbx_a', 'o', { workspacePath: ws('a') }, { gpuIds: [] })
      const pid = Number(fs.readFileSync(`${sandboxes(machine)}/sbx_a/envd.pid`, 'utf8').trim())
      expect(machine.procs.get(pid)!.cmdline[0]).toBe(binOf(machine)) // not sudo
      // The operator bumps AGENTRY_SANDBOX_ENVD_IMAGE: a driver for the new version must still stop the old envd.
      const upgraded = loadConfig({ AGENTRY_SANDBOX_DATABASE_URL: 'postgres://x@localhost/x', AGENTRY_SANDBOX_API_KEYS: `sha256:${'a'.repeat(64)}`, AGENTRY_SANDBOX_SECRET: 's'.repeat(32), AGENTRY_SANDBOX_ENVD_IMAGE: 'ghcr.io/fakhrulfaiz/agentry-envd:envd-v0.7.0' })
      const d2 = createSshMachineDriver(upgraded, { target: `ssh://deploy@127.0.0.1:${String(machine.port)}`, privateKey: userKey.private, hostKey: fpOf(hostKey.public) })
      cleanups.push(() => d2.close?.())
      await d2.stop(h)
      expect(machine.procs.size).toBe(0)
      expect(machine.rules.size).toBe(0)
    })

    it('I2: rules stay and stop fails while envd cannot be stopped', async () => {
      const { machine, driver, ws } = await setup()
      const h = await driver.create('sbx_a', 'o', { workspacePath: ws('a') }, { gpuIds: [] })
      machine.unkillable = true
      await expect(driver.stop(h)).rejects.toThrow(/did not stop/u)
      expect(machine.rules.size).toBe(4)
      expect(machine.procs.size).toBe(1)
    })

    it('I3: stop ends everything in envd\'s session', async () => {
      const { machine, driver, ws } = await setup()
      const h = await driver.create('sbx_a', 'o', { workspacePath: ws('a') }, { gpuIds: [] })
      const sid = Number(fs.readFileSync(`${sandboxes(machine)}/sbx_a/envd.pid`, 'utf8').trim())
      machine.spawnChild(sid)
      machine.spawnChild(sid, 'node')
      const other = machine.spawnChild(99_999, 'unrelated')
      await driver.stop(h)
      expect([...machine.procs.keys()]).toEqual([other])
      expect(machine.log.some((c) => c.includes(`pkill -TERM -s ${String(sid)}`))).toBe(true)
    })

    it('I3: a session whose leader died is still cleaned up on destroy', async () => {
      const { machine, driver, ws } = await setup()
      const h = await driver.create('sbx_a', 'o', { workspacePath: ws('a') }, { gpuIds: [] })
      const sid = Number(fs.readFileSync(`${sandboxes(machine)}/sbx_a/envd.pid`, 'utf8').trim())
      machine.spawnChild(sid)
      const leader = machine.procs.get(sid)!
      leader.server!.closeAllConnections()
      leader.server!.close()
      machine.procs.delete(sid) // envd crashed, its child lives on
      await driver.destroy('sbx_a', h, { keepWorkspace: true })
      expect(machine.procs.size).toBe(0)
    })

    it('I4: loopback connections from other users are rejected before envd starts', async () => {
      const { machine, driver, ws } = await setup()
      const h = await driver.create('sbx_a', 'o', { workspacePath: ws('a') }, { gpuIds: [] })
      const owner = [...machine.rules].filter((r) => r.includes('OUTPUT -o lo') && r.includes(`--dport ${h.port!}`) && r.includes('! --uid-owner 1000') && r.endsWith('-j REJECT'))
      expect(owner).toHaveLength(2)
      const launch = idx(machine.log, 'nohup')
      expect(machine.log.findIndex((c) => c.includes('OUTPUT') && c.includes('-I'))).toBeLessThan(launch)
    })
  })
})
