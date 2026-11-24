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
