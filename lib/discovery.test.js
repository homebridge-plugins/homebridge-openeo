import { describe, expect, it } from 'vitest'

import { expandSubnet } from './discovery.js'

describe('expandSubnet', () => {
  it('expands a /24 to its 254 hosts', () => {
    const hosts = expandSubnet('192.168.20.0/24')
    expect(hosts).toHaveLength(254)
    expect(hosts[0]).toBe('192.168.20.1')
    expect(hosts.at(-1)).toBe('192.168.20.254')
  })

  it('reads a short form as the matching subnet', () => {
    expect(expandSubnet('192.168.20')).toHaveLength(254)
  })

  it('keeps a single address as it is', () => {
    expect(expandSubnet('10.0.0.7')).toEqual(['10.0.0.7'])
  })

  it('refuses ranges bigger than a /20', () => {
    expect(() => expandSubnet('10.0.0.0/16')).toThrow('/20')
  })

  it('refuses something that is not an address', () => {
    expect(() => expandSubnet('300.1.1.0/24')).toThrow('Invalid')
  })
})
