/**
 * The shared bootstrap: what every place does once envd answers, whatever
 * runs the machine.
 *
 * First start provisions through envd as root: the `agent` user with
 * passwordless sudo, template packages (apt or apk), template files, then the
 * template's setup commands as `agent` in the workspace. Later starts only
 * `/init` as `agent`, so whatever the agent installed is still there. DSH's
 * runtime is copied through envd whenever the sandbox does not carry the
 * current runtime ref.
 */
import { createEnvdClient } from '../envd/client.ts'
import { runInEnvd, sq } from '../envd/run.ts'
import { envdToken } from '../envd/token.ts'
import type { TemplateSpec } from '../store/types.ts'
import type { Driver, Handle } from './driver.ts'

const DEFAULT_WORKSPACE = '/workspace'
const workspaceOf = (spec: TemplateSpec) => spec.workspacePath ?? DEFAULT_WORKSPACE
const AGENT = 'agent'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const DSH_TAR = '/tmp/agentry-dsh.tar'

export interface BootstrapOptions {
  /** The service secret envd tokens derive from. */
  secret: string
  /** The DSH runtime as a tar rooted at `dsh/` (Docker's archive format), or null for none. */
  dshRuntime: (() => Promise<Buffer>) | null
  startTimeoutMs: number
  /** Identifies the runtime in `handle.dsh` so it is copied once per ref (default `dsh`). */
  dshRef?: string
}

/** The script that makes `agent` (uid 1000) with passwordless sudo, on Debian-like or Alpine images, and owns the workspace. */
const ensureAgent = (WORKSPACE: string) => `
set -e
if command -v apt-get >/dev/null 2>&1; then PM=apt; elif command -v apk >/dev/null 2>&1; then PM=apk; else PM=none; fi
if ! command -v sudo >/dev/null 2>&1; then
  if [ "$PM" = apt ]; then apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sudo >/dev/null
  elif [ "$PM" = apk ]; then apk add --no-cache -q sudo
  fi
fi
if ! id -u ${AGENT} >/dev/null 2>&1; then
  if command -v useradd >/dev/null 2>&1; then useradd -m -u 1000 -s /bin/sh ${AGENT} 2>/dev/null || useradd -m -s /bin/sh ${AGENT}
  else adduser -D -u 1000 -s /bin/sh ${AGENT} 2>/dev/null || adduser -D -s /bin/sh ${AGENT}
  fi
fi
mkdir -p /etc/sudoers.d
printf '${AGENT} ALL=(ALL) NOPASSWD:ALL\\n' > /etc/sudoers.d/${AGENT}
chmod 0440 /etc/sudoers.d/${AGENT}
mkdir -p ${sq(WORKSPACE)}
chown ${AGENT}: ${sq(WORKSPACE)}
`

function installScript(packages: string[]): string {
  const list = packages.map(sq).join(' ')
  return `set -e
if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${list} >/dev/null
elif command -v apk >/dev/null 2>&1; then apk add --no-cache -q ${list}
else echo "no supported package manager (apt-get or apk) in this image" >&2; exit 1; fi`
}


async function waitHealthy(driver: Driver, handle: Handle, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = 'not started'
  for (;;) {
    try {
      const ep = await driver.envdEndpoint(handle)
      try {
        if (await createEnvdClient({ baseUrl: ep.baseUrl, accessToken: '' }).health(AbortSignal.timeout(2_000))) return
        last = 'health check failed'
      } finally {
        ep.release?.()
      }
    } catch (e) {
      last = (e as Error).message
    }
    if (Date.now() >= deadline) throw new Error(`envd did not become healthy within ${String(timeoutMs)} ms (${last})`)
    await sleep(250)
  }
}

/**
 * Brings a machine whose envd answers to ready: provisions on first start,
 * copies the DSH runtime when stale, and leaves envd initialised as `agent`.
 * Returns the handle marked `provisioned` with the runtime ref.
 */
export async function bootstrap(driver: Driver, id: string, handle: Handle, spec: TemplateSpec, opts: BootstrapOptions): Promise<Handle> {
  await waitHealthy(driver, handle, opts.startTimeoutMs)
  const ep = await driver.envdEndpoint(handle)
  try {
    const accessToken = ep.token ?? envdToken(opts.secret, id)
    const envd = createEnvdClient({ baseUrl: ep.baseUrl, accessToken })
    const base = { accessToken, defaultWorkdir: workspaceOf(spec), ...(spec.env ? { envVars: spec.env } : {}) }
    // The runtime comes from the place's own daemon (its architecture), else from the service's source.
    const source = driver.dshRuntime ? await driver.dshRuntime() : opts.dshRuntime ? { arch: '', tar: opts.dshRuntime } : null
    const baseRef = opts.dshRef ?? 'dsh'
    const ref = source?.arch ? `${baseRef}@${source.arch}` : baseRef
    const first = handle.provisioned !== 'true'
    // A container recreated on its kept workspace (new GPUs) gets only the container-layer steps again.
    const workspaceKept = first && handle.recreated === 'true'
    const copyDsh = source !== null && handle.dsh !== ref
    const must = async (user: string, script: string, what: string, cwd?: string) => {
      const r = await runInEnvd(envd, user, script, { ...(cwd ? { cwd } : {}), ...(spec.env ? { env: spec.env } : {}) })
      if (r.code !== 0) throw new Error(`${what} failed (exit ${String(r.code)}): ${(r.stderr || r.stdout).trim().slice(-500)}`)
    }
    if ((first || copyDsh) && driver.capabilities.runsAsRoot) await envd.init({ ...base, defaultUser: 'root' })
    if (first) await provision(must, envd, spec, workspaceKept)
    if (copyDsh) {
      await envd.writeFile(DSH_TAR, new Uint8Array(await source!.tar()), 'root')
      await must('root', `set -e; mkdir -p /opt/agentry && rm -rf /opt/agentry/dsh && tar -xf ${DSH_TAR} -C /opt/agentry; rm -f ${DSH_TAR}`, 'installing the DSH runtime')
    }
    await envd.init({ ...base, defaultUser: AGENT })
    const { recreated: _r, ...rest } = handle
    return { ...rest, provisioned: 'true', ...(source !== null ? { dsh: ref } : {}) }
  } finally {
    ep.release?.()
  }
}

type Must = (user: string, script: string, what: string, cwd?: string) => Promise<void>

async function provision(must: Must, envd: ReturnType<typeof createEnvdClient>, spec: TemplateSpec, workspaceKept: boolean): Promise<void> {
  const WORKSPACE = workspaceOf(spec)
  await must('root', ensureAgent(WORKSPACE), 'creating the agent user')
  if (spec.packages && spec.packages.length > 0) await must('root', installScript(spec.packages), 'installing packages')
  // Template files and setup commands live in the workspace volume, which survived: running them again would clobber edits.
  if (workspaceKept) return
  for (const file of spec.files ?? []) {
    const path = file.path.startsWith('/') ? file.path : `${WORKSPACE}/${file.path}`
    await must(AGENT, `mkdir -p "$(dirname ${sq(path)})"`, `preparing ${file.path}`)
    await envd.writeFile(path, new TextEncoder().encode(file.content), AGENT)
  }
  for (const command of spec.setupCommands ?? []) await must(AGENT, command, `setup command "${command}"`, WORKSPACE)
}
