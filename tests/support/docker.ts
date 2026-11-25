/** Docker access for integration suites; they skip when no daemon answers. */
import { execFileSync } from 'node:child_process'
import Docker from 'dockerode'

function probe(): boolean {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'pipe', timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

export const dockerAvailable = probe()

function probeDesktop(): boolean {
  if (!dockerAvailable) return false
  try {
    return execFileSync('docker', ['info', '--format', '{{.OperatingSystem}}'], { stdio: 'pipe', timeout: 10_000 }).toString().includes('Docker Desktop')
  } catch {
    return false
  }
}

/** True under Docker Desktop (WSL/macOS), where container IPs are unreachable from the host and `host.docker.internal` resolves. */
export const dockerDesktop = probeDesktop()

let client: Docker | undefined
export function docker(): Docker {
  client ??= new Docker()
  return client
}

/** Runs a command in a throwaway container of `image`; resolves with exit code and combined output. */
export async function runOnce(image: string, cmd: string[], user?: string, opts: { privileged?: boolean; hostNet?: boolean } = {}): Promise<{ code: number; output: string }> {
  const d = docker()
  const container = await d.createContainer({ Image: image, Cmd: cmd, ...(user ? { User: user } : {}), Tty: true, HostConfig: { AutoRemove: false, ...(opts.privileged ? { Privileged: true } : {}), ...(opts.hostNet ? { NetworkMode: 'host' } : {}) } })
  try {
    await container.start()
    const { StatusCode } = (await container.wait()) as { StatusCode: number }
    const logs = await container.logs({ stdout: true, stderr: true })
    return { code: StatusCode, output: logs.toString('utf8') }
  } finally {
    await container.remove({ force: true })
  }
}

/** Reads one file out of an image as a tar stream length (used to prove a file exists). */
export async function fileSizeInImage(image: string, path: string): Promise<number> {
  const d = docker()
  const container = await d.createContainer({ Image: image, Cmd: ['/envd'] })
  try {
    const stream = await container.getArchive({ path })
    let size = 0
    for await (const chunk of stream as AsyncIterable<Buffer>) size += chunk.length
    return size
  } finally {
    await container.remove({ force: true })
  }
}
