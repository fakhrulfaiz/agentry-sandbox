/**
 * A stand-in EnvdClient whose `process` service runs commands on this machine (a real `/bin/sh`), for tests of code
 * that streams through envd when no Docker is around. Only `start`, `sendInput` and `closeStdin` are implemented.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { EnvdClient } from '../../src/envd/client.ts'

type Ev = { event?: { event: { case: 'start'; value: { pid: number } } | { case: 'data'; value: { output: { case: 'stdout' | 'stderr'; value: Uint8Array } } } | { case: 'end'; value: { exitCode: number } } } }

export function localEnvd(): EnvdClient & { started: string[] } {
  const procs = new Map<string, ChildProcessWithoutNullStreams>()
  const started: string[] = []
  const process = {
    async *start(req: { process?: { cmd: string; args: string[] }; tag?: string; stdin?: boolean }, opts?: { signal?: AbortSignal }): AsyncGenerator<Ev> {
      const p = req.process!
      started.push(p.args.join(' '))
      const child = spawn(p.cmd, p.args, { stdio: ['pipe', 'pipe', 'pipe'] })
      if (req.tag) procs.set(req.tag, child)
      if (!req.stdin) child.stdin.end()
      opts?.signal?.addEventListener('abort', () => child.kill('SIGKILL'))
      yield { event: { event: { case: 'start', value: { pid: child.pid ?? 0 } } } }
      const queue: Ev[] = []
      let wake: () => void = () => {}
      let done = false
      const push = (e: Ev) => { queue.push(e); wake() }
      child.stdout.on('data', (b: Buffer) => push({ event: { event: { case: 'data', value: { output: { case: 'stdout', value: new Uint8Array(b) } } } } }))
      child.stderr.on('data', (b: Buffer) => push({ event: { event: { case: 'data', value: { output: { case: 'stderr', value: new Uint8Array(b) } } } } }))
      child.stdin.on('error', () => {})
      // 'close' fires after the output streams ended, so no data is lost behind the end event.
      child.on('close', (code, signal) => { push({ event: { event: { case: 'end', value: { exitCode: code ?? (signal ? 137 : 1) } } } }); done = true; wake() })
      for (;;) {
        while (queue.length > 0) {
          const e = queue.shift()!
          yield e
          if (e.event?.event.case === 'end') return
        }
        if (done) return
        await new Promise<void>((r) => { wake = r })
        wake = () => {}
      }
    },
    async sendInput(req: { process?: { selector: { value: string } }; input?: { input: { value: Uint8Array } } }) {
      const child = procs.get(req.process!.selector.value)
      if (!child) throw new Error('no such process')
      await new Promise<void>((res, rej) => child.stdin.write(Buffer.from(req.input!.input.value), (e) => (e ? rej(e) : res())))
      return {}
    },
    async closeStdin(req: { process?: { selector: { value: string } } }) {
      procs.get(req.process!.selector.value)?.stdin.end()
      return {}
    },
  }
  return {
    started,
    process: process as unknown as EnvdClient['process'],
    userHeaders: () => ({}),
  } as unknown as EnvdClient & { started: string[] }
}
