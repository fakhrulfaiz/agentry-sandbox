import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createEnvdClient } from '../src/envd/client.ts'
import { dockerAvailable } from './support/docker.ts'
import { startBareEnvd, type BareEnvd } from './support/bare-envd.ts'

describe.skipIf(!dockerAvailable)('envd client against a real envd', () => {
  let envd: BareEnvd
  beforeAll(async () => {
    envd = await startBareEnvd()
    await createEnvdClient({ baseUrl: envd.baseUrl, accessToken: 't' }).init({ accessToken: 't', defaultUser: 'root', defaultWorkdir: '/tmp' })
  })
  afterAll(async () => envd?.stop())

  it('runs a process and streams its output', async () => {
    const client = createEnvdClient({ baseUrl: envd.baseUrl, accessToken: 't' })
    let stdout = ''
    let stderr = ''
    let exit: number | undefined
    for await (const res of client.process.start({ process: { cmd: '/bin/sh', args: ['-c', 'echo hi; echo err >&2; exit 3'], envs: {} } }, { headers: client.userHeaders('root') })) {
      const ev = res.event?.event
      if (ev?.case === 'data') {
        if (ev.value.output.case === 'stdout') stdout += new TextDecoder().decode(ev.value.output.value)
        if (ev.value.output.case === 'stderr') stderr += new TextDecoder().decode(ev.value.output.value)
      }
      if (ev?.case === 'end') exit = ev.value.exitCode
    }
    expect(stdout).toBe('hi\n')
    expect(stderr).toBe('err\n')
    expect(exit).toBe(3)
  })

  it('writes and reads a file', async () => {
    const client = createEnvdClient({ baseUrl: envd.baseUrl, accessToken: 't' })
    await client.writeFile('/tmp/a.txt', new TextEncoder().encode('hello'), 'root')
    expect(new TextDecoder().decode(await client.readFile('/tmp/a.txt', 'root'))).toBe('hello')
  })

  it('refuses a call without the access token', async () => {
    const wrong = createEnvdClient({ baseUrl: envd.baseUrl, accessToken: 'wrong' })
    await expect(wrong.filesystem.stat({ path: '/tmp' }, { headers: wrong.userHeaders('root') })).rejects.toThrow()
    await expect(wrong.readFile('/tmp/a.txt', 'root')).rejects.toThrow()
  })
})

describe('envd client headers', () => {
  it('the envd client sends extra headers', async () => {
    const seen: http.IncomingHttpHeaders[] = []
    const srv = http.createServer((req, res) => {
      seen.push(req.headers)
      res.writeHead(204).end()
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    try {
      const client = createEnvdClient({ baseUrl: `http://127.0.0.1:${String((srv.address() as AddressInfo).port)}`, accessToken: 'tok', headers: { 'E2b-Sandbox-Id': 'sbx1', 'E2b-Sandbox-Port': '49983' } })
      expect(await client.health()).toBe(true)
      await client.init({ accessToken: 'tok', defaultUser: 'root', defaultWorkdir: '/' })
      await client.readFile('/x', 'root').catch(() => undefined)
      await client.filesystem.stat({ path: '/' }, { headers: client.userHeaders('root') }).catch(() => undefined)
      expect(seen.length).toBeGreaterThanOrEqual(4)
      for (const h of seen) {
        expect(h['e2b-sandbox-id']).toBe('sbx1')
        expect(h['e2b-sandbox-port']).toBe('49983')
      }
    } finally {
      srv.closeAllConnections()
      await new Promise<void>((r) => srv.close(() => r()))
    }
  })
})
