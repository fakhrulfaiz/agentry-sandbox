/** A plain debian container running the injected envd, published on 127.0.0.1 only, for client tests. */
import type Docker from 'dockerode'
import { docker } from './docker.ts'
import { envdArchive } from '../../src/backends/envd-binary.ts'

export interface BareEnvd {
  baseUrl: string
  container: Docker.Container
  stop(): Promise<void>
}

export async function startBareEnvd(image = 'debian:bookworm-slim'): Promise<BareEnvd> {
  const d = docker()
  const container = await d.createContainer({
    Image: image,
    Entrypoint: ['/opt/agentry/envd', '--isnotfc', '--no-cgroups', '--port', '49983'],
    Cmd: [],
    Labels: { 'agentry.test': 'bare-envd' },
    ExposedPorts: { '49983/tcp': {} },
    HostConfig: { Init: true, PortBindings: { '49983/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] } },
  })
  await container.putArchive(await envdArchive(d, 'agentry/envd:envd-v0.6.13'), { path: '/' })
  await container.start()
  const info = await container.inspect()
  const port = info.NetworkSettings.Ports['49983/tcp']?.[0]?.HostPort
  if (!port) throw new Error('envd port was not published')
  const baseUrl = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      if ((await fetch(`${baseUrl}/health`)).status === 204) break
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('envd did not become healthy')
    await new Promise((r) => setTimeout(r, 250))
  }
  return { baseUrl, container, stop: () => container.remove({ force: true }) }
}
