import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { loadEnvdBinary, treeArchive } from '../src/backends/envd-binary.ts'
import { dockerAvailable, docker } from './support/docker.ts'

const AMD64 = 'ghcr.io/fakhrulfaiz/agentry-envd:envd-v0.6.13'
const ARM64 = 'agentry-test/envd:arm64'

function haveImage(tag: string, arch: string): boolean {
  try {
    return execFileSync('docker', ['image', 'inspect', tag, '--format', '{{.Architecture}}'], { stdio: 'pipe' }).toString().trim() === arch
  } catch {
    return false
  }
}

/** Builds the arm64 envd image locally (cached builds take seconds); false when cross-building is unavailable. */
function buildArm64(): boolean {
  if (haveImage(ARM64, 'arm64')) return true
  const cfg = mkdtempSync(join(tmpdir(), 'dockercfg-'))
  try {
    writeFileSync(join(cfg, 'config.json'), '{}')
    execFileSync('docker', ['buildx', 'build', '--platform', 'linux/arm64', '--load', '-t', ARM64, 'images/envd'], { stdio: 'pipe', timeout: 280_000, env: { ...process.env, DOCKER_CONFIG: cfg } })
    return haveImage(ARM64, 'arm64')
  } catch {
    return false
  } finally {
    rmSync(cfg, { recursive: true, force: true })
  }
}

describe('envd-binary platform', () => {
  it('passes the platform to ensure and createContainer, and caches per platform', async () => {
    const created: unknown[] = []
    const fake = {
      createContainer: async (o: unknown) => {
        created.push(o)
        return {
          getArchive: async () => {
            const { pack } = await import('tar-stream')
            const p = pack()
            p.entry({ name: 'envd' }, Buffer.from('x'))
            p.finalize()
            return p
          },
          remove: async () => {},
        }
      },
    }
    const ensure = vi.fn(async () => {})
    await loadEnvdBinary(fake as never, 'img', ensure, 'linux/arm64')
    await loadEnvdBinary(fake as never, 'img', ensure, 'linux/arm64')
    await loadEnvdBinary(fake as never, 'img', ensure)
    expect(ensure).toHaveBeenCalledWith('img', 'linux/arm64')
    expect(created).toHaveLength(2)
    expect(created[0]).toMatchObject({ platform: 'linux/arm64' })
    expect(created[1]).not.toHaveProperty('platform')
    void treeArchive
  })

  describe.skipIf(!dockerAvailable)('against the local Docker', () => {
    let arm = false
    beforeAll(() => {
      arm = haveImage(AMD64, 'amd64') && buildArm64()
    }, 300_000)

    it('loads envd for the requested platform', async (ctx) => {
      if (!arm) return ctx.skip()
      const a = await loadEnvdBinary(docker(), AMD64, undefined, 'linux/amd64')
      const b = await loadEnvdBinary(docker(), ARM64, undefined, 'linux/arm64')
      expect(a.equals(b)).toBe(false)
      expect(b.subarray(0, 4)).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      expect(b.readUInt16LE(18)).toBe(0xb7)
      expect(a.readUInt16LE(18)).toBe(0x3e)
    }, 60_000)
  })
})
