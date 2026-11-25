/**
 * Sandbox networking for Docker: one bridge per owner with inter-container
 * traffic off, and firewall rules (applied in the Docker host's network
 * namespace by a short-lived privileged helper) so sandboxes reach the
 * internet but not the host, the LAN, private ranges or cloud metadata.
 * A network-off sandbox gets no new outbound connections at all.
 *
 * Every rule carries an `agentry-…` comment, so the guard only ever adds or
 * removes its own rules. Rules are re-checked on every sandbox start, which
 * also restores them after the Docker host restarts.
 */
import { createHash } from 'node:crypto'
import type Docker from 'dockerode'
import type { SandboxConfig } from '../config.ts'
import type { NetworkGuard } from './types.ts'

/** Private, link-local, shared, reserved and multicast ranges, plus cloud metadata hosts: sandboxes reach the public internet only. */
export const BLOCKED_RANGES = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4', '168.63.129.16/32']
export const GUARD_IMAGE = 'ghcr.io/fakhrulfaiz/agentry-netguard:1'

export const ownerNetworkName = (owner: string) => `agentry-sbx-${createHash('sha256').update(owner).digest('hex').slice(0, 12)}`

const isNotFound = (e: unknown) => (e as { statusCode?: number }).statusCode === 404

/** Shell that adds a rule unless present (`add CHAIN args…` inserts at the top of CHAIN). */
const PRELUDE = `set -e
add() { chain=$1; shift; iptables -C "$chain" "$@" 2>/dev/null || iptables -I "$chain" 1 "$@"; }
drop_tagged() { for chain in DOCKER-USER INPUT; do iptables -S "$chain" | grep -F -- "--comment $1" | sed 's/^-A /-D /' | while read -r rule; do eval iptables "$rule"; done; done; }
`

function subnetRules(subnet: string, tag: string): string {
  const lines = BLOCKED_RANGES.map((range) => `add DOCKER-USER -s ${subnet} -d ${range} -m conntrack --ctstate NEW -m comment --comment ${tag} -j DROP`)
  // New connections from the sandbox network to the Docker host itself (gateway, host.docker.internal, published ports).
  lines.push(`add INPUT -s ${subnet} -m conntrack --ctstate NEW -m comment --comment ${tag} -j DROP`)
  return lines.join('\n')
}

export interface DockerNetworkGuard extends NetworkGuard {
  removeOwnerNetwork(owner: string): Promise<void>
  /** Drops `agentry-c-*` rules of containers not in `active` (left by crashes or older versions). */
  prune(activeContainerIds: string[]): Promise<number>
}

/** Owner networks get /24s from this pool, so many owners fit (Docker's defaults hand out whole /16s). */
export const SUBNET_POOL_PREFIX = '10.213'

export function createNetworkGuard(docker: Docker, config: SandboxConfig): DockerNetworkGuard {
  async function helper(script: string): Promise<void> {
    const container = await docker.createContainer({
      Image: GUARD_IMAGE,
      Cmd: [PRELUDE + script],
      Labels: { 'agentry.netguard': 'true' },
      HostConfig: { NetworkMode: 'host', Privileged: true, AutoRemove: false },
    })
    try {
      await container.start()
      const { StatusCode } = (await container.wait()) as { StatusCode: number }
      if (StatusCode !== 0) {
        const logs = (await container.logs({ stdout: true, stderr: true })).toString('utf8')
        throw new Error(`network guard failed (exit ${String(StatusCode)}): ${logs.trim().slice(-400)}`)
      }
    } finally {
      await container.remove({ force: true }).catch(() => {})
    }
  }

  async function subnetOf(name: string): Promise<string | undefined> {
    return (await docker.getNetwork(name).inspect()).IPAM?.Config?.[0]?.Subnet
  }

  return {
    async networkFor(owner) {
      const name = ownerNetworkName(owner)
      try {
        await docker.getNetwork(name).inspect()
        return name
      } catch (e) {
        if (!isNotFound(e)) throw e
      }
      const used = new Set<string>()
      for (const n of await docker.listNetworks()) for (const c of n.IPAM?.Config ?? []) if (c.Subnet) used.add(c.Subnet)
      for (let i = 0; i < 256; i++) {
        const subnet = `${SUBNET_POOL_PREFIX}.${String(i)}.0/24`
        if (used.has(subnet)) continue
        try {
          await docker.createNetwork({
            Name: name,
            Driver: 'bridge',
            EnableIPv6: false,
            IPAM: { Driver: 'default', Config: [{ Subnet: subnet, Gateway: `${SUBNET_POOL_PREFIX}.${String(i)}.1` }] },
            Options: { 'com.docker.network.bridge.enable_icc': 'false' },
            Labels: { 'agentry.managed': 'true', 'agentry.network.owner': owner },
          })
          return name
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode
          // Another create for this owner won the race: use its network.
          if (code === 409) {
            try {
              await docker.getNetwork(name).inspect()
              return name
            } catch {
              continue
            }
          }
          // The subnet overlaps a network Docker knows another way: try the next one.
          if (/overlap|pool/i.test((e as Error).message)) continue
          throw e
        }
      }
      throw new Error('no free sandbox subnet left in the pool')
    },

    async releaseFor(containerId) {
      if (!config.egress) return
      await helper(`drop_tagged agentry-c-${containerId.slice(0, 12)}`)
    },

    async prune(active) {
      if (!config.egress) return 0
      const keep = active.map((id) => `agentry-c-${id.slice(0, 12)}`).join(' ')
      const script = `keep="${keep}"; n=0
for tag in $( (iptables -S DOCKER-USER; iptables -S INPUT) | grep -o 'agentry-c-[0-9a-f]*' | sort -u); do
  case " $keep " in *" $tag "*) ;; *) drop_tagged "$tag"; n=$((n+1));; esac
done
echo "pruned=$n"`
      await helper(script)
      return 0
    },

    async applyFor(containerId, { network }) {
      if (!config.egress) return
      const info = await docker.getContainer(containerId).inspect()
      const [netName, net] = Object.entries(info.NetworkSettings.Networks ?? {})[0] ?? []
      if (!netName || !net) return
      const subnet = netName.startsWith('agentry-sbx-') ? await subnetOf(netName) : undefined
      const tag = `agentry-c-${containerId.slice(0, 12)}`
      const parts = [subnet ? subnetRules(subnet, `agentry-n-${netName}`) : '', `drop_tagged ${tag}`]
      if (!network && net.IPAddress) {
        parts.push(`add DOCKER-USER -s ${net.IPAddress} -m conntrack --ctstate NEW -m comment --comment ${tag} -j DROP`)
        parts.push(`add INPUT -s ${net.IPAddress} -m conntrack --ctstate NEW -m comment --comment ${tag} -j DROP`)
      }
      await helper(parts.filter(Boolean).join('\n'))
    },

    async removeOwnerNetwork(owner) {
      const name = ownerNetworkName(owner)
      await helper(`drop_tagged agentry-n-${name}`).catch(() => {})
      await docker.getNetwork(name).remove().catch((e: unknown) => {
        if (!isNotFound(e)) throw e
      })
    },
  }
}
