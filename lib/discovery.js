/**
 * Finds OpenEO chargers on the network.
 *
 * 1. Tries openeo.local (OpenEO's SD image sets the hostname to "openeo").
 * 2. Scans every host in this machine's own IPv4 subnets, plus any extra
 *    subnets given (e.g. an IoT VLAN), asking each for /getstatus on port 80.
 *    Anything returning OpenEO's status JSON is a charger.
 *
 * Used by both the plugin and the Homebridge UI page.
 */

import os from 'node:os'

const MAX_HOSTS = 4096

export async function probe(host, timeoutMs = 1000, port = 80) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`http://${port === 80
      ? host
      : `${host}:${port}`}/getstatus`, { signal: controller.signal })
    if (!res.ok) {
      return null
    }
    const json = await res.json()
    if (!json || typeof json !== 'object' || !('eo_charger_state_id' in json)) {
      return null
    }
    return {
      host: port === 80
        ? host
        : `${host}:${port}`,
      serial: json.eo_serial_number
        ? String(json.eo_serial_number)
        : '',
      name: json.charger_name || 'OpenEO charger',
      version: json.app_version
        ? String(json.app_version)
        : '',
      state: json.eo_charger_state || '',
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const ipToInt = ip => ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0
const intToIp = n => [24, 16, 8, 0].map(s => (n >>> s) & 255).join('.')

/** "192.168.20.0/24", "192.168.20.0/23", "192.168.20" or a single IP -> list of host IPs */
export function expandSubnet(spec) {
  spec = String(spec).trim()
  if (!spec) {
    return []
  }
  let [addr, bits] = spec.split('/')
  const parts = addr.split('.').filter(p => p !== '')
  if (parts.length < 4) {
    while (parts.length < 4) {
      parts.push('0')
    }
    bits = bits ?? String(spec.split('/')[0].split('.').filter(Boolean).length * 8)
  }
  addr = parts.join('.')
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(addr) || parts.some(p => Number(p) > 255)) {
    throw new Error(`Invalid subnet "${spec}"`)
  }
  // A bare network address like 192.168.20.0 means the /24
  const prefix = bits === undefined
    ? (addr.endsWith('.0')
        ? 24
        : 32)
    : Number(bits)
  if (!Number.isInteger(prefix) || prefix < 20 || prefix > 32) {
    throw new Error(`Subnet "${spec}" must be between /20 and /32`)
  }
  if (prefix === 32) {
    return [addr]
  }
  const mask = (0xFFFFFFFF << (32 - prefix)) >>> 0
  const network = ipToInt(addr) & mask
  const size = 2 ** (32 - prefix)
  const hosts = []
  for (let i = 1; i < size - 1; i++) {
    hosts.push(intToIp((network + i) >>> 0))
  }
  return hosts
}

/** This machine's IPv4 subnets, capped at /24 so a big LAN doesn't mean a huge scan. */
export function localSubnets() {
  const out = []
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) {
        continue
      }
      if (a.internal || a.address.startsWith('169.254.')) {
        continue
      }
      const prefix = a.cidr
        ? Math.max(Number(a.cidr.split('/')[1]), 24)
        : 24
      out.push(`${a.address}/${prefix}`)
    }
  }
  return [
    ...new Set(out),
  ]
}

export async function discover({
  subnets = [],
  timeoutMs = 1000,
  concurrency = 64,
  log,
  skipLocalName = false,
  skipLocalSubnets = false,
  port = 80,
} = {}) {
  const found = new Map()
  const logDebug = m => log && (log.debug
    ? log.debug(m)
    : log(m))

  if (!skipLocalName) {
    const hit = await probe('openeo.local', 2500, port)
    if (hit) {
      // Prefer the IP: .local lookups are slower and fail across VLANs/Docker
      found.set(hit.serial || hit.host, hit)
    }
  }

  const ranges = [
    ...(skipLocalSubnets
      ? []
      : localSubnets()),
    ...subnets,
  ]
  const hosts = new Set()
  for (const r of ranges) {
    try {
      for (const h of expandSubnet(r)) {
        hosts.add(h)
      }
    } catch (err) {
      if (log) {
        ;(log.warn || log)(`Discovery: ${err.message}`)
      }
    }
    if (hosts.size > MAX_HOSTS) {
      break
    }
  }
  logDebug(`Discovery: scanning ${hosts.size} addresses in ${ranges.join(', ') || '(none)'}`)

  const queue = [...hosts].slice(0, MAX_HOSTS)
  const worker = async () => {
    while (queue.length) {
      const h = queue.shift()
      const hit = await probe(h, timeoutMs, port)
      if (hit) {
        const key = hit.serial || hit.host
        const prev = found.get(key)
        // Replace a .local hit with the numeric IP for the same charger
        if (!prev || prev.host === 'openeo.local') {
          found.set(key, hit)
        }
      }
    }
  }
  await Promise.all(
    Array.from(
      {
        length: Math.min(concurrency, queue.length || 1),
      },
      worker,
    ),
  )
  return [
    ...found.values(),
  ]
}
