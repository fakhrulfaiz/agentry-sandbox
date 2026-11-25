/**
 * Exclusive GPU assignment: GPUs are handed out like seats per place, never shared.
 */
import type { GpuInfo } from '../store/types.ts'

/**
 * Picks GPUs from the free ones, lowest index first. `'all'` needs every GPU of the place free.
 * Returns `undefined` when there are too few.
 */
export function assignGpus(free: GpuInfo[], want: number | 'all', total: number): GpuInfo[] | undefined {
  const sorted = [...free].sort((a, b) => a.index - b.index)
  if (want === 'all') return total > 0 && sorted.length === total ? sorted : undefined
  if (want <= 0) return []
  return sorted.length >= want ? sorted.slice(0, want) : undefined
}

/** Parses `nvidia-smi --query-gpu=index,uuid,name --format=csv,noheader` output. */
export function parseNvidiaSmi(text: string): GpuInfo[] {
  const out: GpuInfo[] = []
  for (const line of text.split(/\r?\n/u)) {
    const parts = line.split(',').map((p) => p.trim())
    if (parts.length < 3) continue
    const index = Number(parts[0])
    if (!Number.isInteger(index) || !parts[1]) continue
    out.push({ index, uuid: parts[1], name: parts.slice(2).join(', ') })
  }
  return out.sort((a, b) => a.index - b.index)
}
