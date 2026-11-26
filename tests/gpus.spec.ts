import { describe, expect, it } from 'vitest'
import { assignGpus, parseNvidiaSmi } from '../src/places/gpus.ts'

const g = (index: number) => ({ index, uuid: `GPU-${String(index)}`, name: 'A100' })

describe('assignGpus', () => {
  it('assignGpus picks lowest free indices', () => {
    expect(assignGpus([g(3), g(1), g(2)], 2, 4)?.map((x) => x.index)).toEqual([1, 2])
    expect(assignGpus([g(0)], 2, 2)).toBeUndefined()
    expect(assignGpus([g(0)], 0, 2)).toEqual([])
  })

  it("assignGpus 'all' needs every GPU free", () => {
    expect(assignGpus([g(0), g(1)], 'all', 2)?.length).toBe(2)
    expect(assignGpus([g(1)], 'all', 2)).toBeUndefined()
    expect(assignGpus([], 'all', 0)).toBeUndefined()
  })
})

describe('Docker GPU probe', () => {
  it('the Docker driver parses nvidia-smi csv', () => {
    const csv = '1, GPU-bbbb, NVIDIA A100-SXM4-80GB\n0, GPU-aaaa, NVIDIA A100-SXM4-80GB\n\n'
    expect(parseNvidiaSmi(csv)).toEqual([
      { index: 0, uuid: 'GPU-aaaa', name: 'NVIDIA A100-SXM4-80GB' },
      { index: 1, uuid: 'GPU-bbbb', name: 'NVIDIA A100-SXM4-80GB' },
    ])
    expect(parseNvidiaSmi('NVIDIA-SMI has failed')).toEqual([])
  })
})
