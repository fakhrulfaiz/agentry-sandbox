import { describe, expect, it } from 'vitest'
import { dockerAvailable, fileSizeInImage, runOnce } from './support/docker.ts'

describe.skipIf(!dockerAvailable)('images', () => {
  it('envd image holds a static envd binary and its license', async () => {
    expect(await fileSizeInImage('agentry/envd:envd-v0.6.13', '/envd')).toBeGreaterThan(1_000_000)
    expect(await fileSizeInImage('agentry/envd:envd-v0.6.13', '/LICENSE')).toBeGreaterThan(1_000)
  })

  it('sandbox image has the agent user with passwordless sudo, Node 24 and the Office packages', async () => {
    const r = await runOnce('agentry/sandbox:1', ['sh', '-c', 'id -u && sudo -n true && echo sudo-ok && node -v && python3 -c "import docx, pptx, openpyxl; print(\'py-ok\')" && stat -c %U /workspace'], 'agent')
    expect(r.code).toBe(0)
    expect(r.output).toContain('1000')
    expect(r.output).toContain('sudo-ok')
    expect(r.output).toContain('v24.')
    expect(r.output).toContain('py-ok')
    expect(r.output).toContain('agent')
  })
})
