/** Runs one command through envd and collects its output (provisioning and tests). */
import type { EnvdClient } from './client.ts'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export async function runInEnvd(
  client: EnvdClient,
  user: string,
  script: string,
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<RunResult> {
  const decoder = new TextDecoder()
  let stdout = ''
  let stderr = ''
  let code = -1
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 600_000)
  const stream = client.process.start(
    { process: { cmd: '/bin/sh', args: ['-c', script], envs: opts.env ?? {}, ...(opts.cwd ? { cwd: opts.cwd } : {}) }, stdin: false },
    { headers: client.userHeaders(user), signal },
  )
  for await (const res of stream) {
    const ev = res.event?.event
    if (ev?.case === 'data') {
      const out = ev.value.output
      if (out.case === 'stdout') stdout += decoder.decode(out.value)
      else if (out.case === 'stderr') stderr += decoder.decode(out.value)
    } else if (ev?.case === 'end') {
      code = ev.value.exitCode
    }
  }
  return { code, stdout, stderr }
}

/** Shell-quotes one argument for `/bin/sh -c`. */
export const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
