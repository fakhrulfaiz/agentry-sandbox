import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { ROUTES } from '../src/http/server.ts'

describe('openapi drift', () => {
  it('documents every route and nothing more', () => {
    const doc = parse(readFileSync(new URL('../openapi/agentry-sandbox.yaml', import.meta.url), 'utf8')) as { paths: Record<string, Record<string, unknown>> }
    const documented = Object.entries(doc.paths).flatMap(([path, ops]) => Object.keys(ops).filter((m) => ['get', 'post', 'put', 'delete'].includes(m)).map((m) => `${m.toUpperCase()} ${path}`))
    const routed = ROUTES.map((r) => `${r.method} ${r.openapi}`)
    expect([...documented].sort()).toEqual([...routed].sort())
  })
})
