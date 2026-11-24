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

export const BLOCKED_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10']
export const GUARD_IMAGE = 'agentry/netguard:1'

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
}

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
      } catch (e) {
        if (!isNotFound(e)) throw e
        await docker.createNetwork({
          Name: name,
          Driver: 'bridge',
          Options: { 'com.docker.network.bridge.enable_icc': 'false' },
          Labels: { 'agentry.managed': 'true', 'agentry.network.owner': owner },
        })
      }
      return name
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
