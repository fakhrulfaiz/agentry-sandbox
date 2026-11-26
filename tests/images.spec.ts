import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { dockerAvailable, fileSizeInImage, runOnce } from './support/docker.ts'

describe.skipIf(!dockerAvailable)('images', () => {
  it('envd image holds a static envd binary and its license', async () => {
    expect(await fileSizeInImage('ghcr.io/fakhrulfaiz/agentry-envd:envd-v0.6.13', '/envd')).toBeGreaterThan(1_000_000)
    expect(await fileSizeInImage('ghcr.io/fakhrulfaiz/agentry-envd:envd-v0.6.13', '/LICENSE')).toBeGreaterThan(1_000)
  })

  it('sandbox image has the agent user with passwordless sudo, Node 24 and the Office packages', async () => {
    const r = await runOnce('ghcr.io/fakhrulfaiz/agentry-sandbox:1', ['sh', '-c', 'id -u && sudo -n true && echo sudo-ok && node -v && python3 -c "import docx, pptx, openpyxl; print(\'py-ok\')" && stat -c %U /workspace'], 'agent')
    expect(r.code).toBe(0)
    expect(r.output).toContain('1000')
    expect(r.output).toContain('sudo-ok')
    expect(r.output).toContain('v24.')
    expect(r.output).toContain('py-ok')
    expect(r.output).toContain('agent')
  })
})

const NAMES = [
  'ghcr.io/fakhrulfaiz/agentry-envd:envd-v0.6.13',
  'ghcr.io/fakhrulfaiz/agentry-dsh-runtime:0.2.2-rc.1',
  'ghcr.io/fakhrulfaiz/agentry-sandbox:1',
  'ghcr.io/fakhrulfaiz/agentry-netguard:1',
]

describe('image names', () => {
  it('config defaults name the ghcr.io/fakhrulfaiz images', () => {
    const c = loadConfig({ AGENTRY_SANDBOX_DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x', AGENTRY_SANDBOX_API_KEYS: `sha256:${'a'.repeat(64)}`, AGENTRY_SANDBOX_SECRET: 's'.repeat(32) })
    expect(c.envdImage).toBe(NAMES[0])
    expect(c.dshRuntimeImage).toBe(NAMES[1])
    expect(c.defaultImage).toBe(NAMES[2])
  })

  it('images-build.sh builds every default image name', () => {
    const script = readFileSync(new URL('../scripts/images-build.sh', import.meta.url), 'utf8')
    for (const n of NAMES) expect(script).toContain(`-t ${n} `)
  })

  it('the envd and sandbox Dockerfiles follow TARGETARCH, and images.yml publishes every name for both architectures', () => {
    const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
    expect(read('images/envd/Dockerfile')).toContain('GOARCH=${TARGETARCH}')
    expect(read('images/sandbox/Dockerfile')).toContain('TARGETARCH')
    const wf = read('.github/workflows/images.yml')
    for (const n of NAMES) expect(wf).toContain(n)
    expect(wf).toContain('linux/amd64,linux/arm64')
  })
})

describe('sandbox Dockerfile', () => {
  it('ships the pinned Playwright MCP and its Chromium in a shared folder, and lists them', () => {
    const f = readFileSync(new URL('../images/sandbox/Dockerfile', import.meta.url), 'utf8')
    expect(f).toContain('ARG PLAYWRIGHT_MCP_VERSION=0.0.80')
    expect(f).toContain('npm install -g "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}"')
    expect(f).toContain('ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright')
    expect(f).toContain('install --with-deps chromium')
    // Playwright writes its own state under ~/.cache/ms-playwright; linking it to the read-only folder breaks it.
    expect(f).not.toMatch(/ln -s \/opt\/ms-playwright/)
    expect(f).toMatch(/org\.agentry\.tools="[^"]*chromium playwright-mcp/)
  })
})

describe('dsh-runtime Dockerfile', () => {
  it('uses TARGETARCH to pick the Node tarball', () => {
    const f = readFileSync(new URL('../images/dsh-runtime/Dockerfile', import.meta.url), 'utf8')
    expect(f).toContain('ARG TARGETARCH')
    expect(f).toMatch(/arm64/)
    expect(f).toContain('linux-${NODE_ARCH}.tar.xz')
    expect(f).not.toContain('linux-x64')
  })
})
