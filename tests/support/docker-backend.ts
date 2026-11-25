/** The Docker driver plus the shared bootstrap as one create/start, for integration tests. */
import type { SandboxConfig } from '../../src/config.ts'
import { bootstrap } from '../../src/places/bootstrap.ts'
import type { Handle, NetworkGuard } from '../../src/places/driver.ts'
import { createDockerDriver, dockerDshRuntime } from '../../src/places/drivers/docker.ts'
import type { TemplateSpec } from '../../src/store/types.ts'

export function createDockerBackend(cfg: SandboxConfig, guard: NetworkGuard) {
  const driver = createDockerDriver(cfg, guard)
  const opts = { secret: cfg.secret, dshRuntime: dockerDshRuntime(cfg), startTimeoutMs: cfg.startTimeoutMs, dshRef: cfg.dshRuntimeImage }
  const ctx = { gpuIds: [] }
  return {
    endpoint: (h: Handle) => driver.envdEndpoint(h),
    stop: (h: Handle) => driver.stop(h),
    destroy: (id: string, h: Handle, o: { keepWorkspace: boolean }) => driver.destroy(id, h, o),
    releaseOwner: (owner: string) => driver.releaseOwner!(owner),
    async create(id: string, owner: string, spec: TemplateSpec): Promise<Handle> {
      const h = await driver.create(id, owner, spec, ctx)
      try {
        return await bootstrap(driver, id, h, spec, opts)
      } catch (e) {
        await driver.destroy(id, h, { keepWorkspace: false }).catch(() => {})
        throw e
      }
    },
  }
}
