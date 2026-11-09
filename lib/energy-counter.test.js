import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { EnergyCounter } from './energy-counter.js'

const log = {
  warn: () => {},
}
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'openeo-energy-')), 'energy.json')

describe('energyCounter', () => {
  it('does not count energy from before the plugin was watching', () => {
    const c = new EnergyCounter(tmpFile(), log)
    expect(c.update(4.2, 100)).toBe(false)
    expect(c.totalWh).toBe(0)
  })

  it('adds what the session gained between readings', () => {
    const c = new EnergyCounter(tmpFile(), log)
    c.update(4.2, 100)
    expect(c.update(5.7, 100)).toBe(true)
    expect(c.totalWh).toBeCloseTo(1500)
  })

  it('counts a new session from zero', () => {
    const c = new EnergyCounter(tmpFile(), log)
    c.update(4.2, 100)
    c.update(0.5, 200)
    expect(c.totalWh).toBeCloseTo(500)
  })

  it('keeps the total across a restart', () => {
    const file = tmpFile()
    const a = new EnergyCounter(file, log)
    a.update(1, 100)
    a.update(3, 100)
    a.save()
    const b = new EnergyCounter(file, log)
    expect(b.totalWh).toBeCloseTo(2000)
    b.update(3.5, 100)
    expect(b.totalWh).toBeCloseTo(2500)
  })
  it('skips an older reading that arrives late, instead of counting the session again', () => {
    const c = new EnergyCounter(tmpFile(), log)
    c.update(5, 100)
    c.update(5.02, 100)
    expect(c.update(5.01, 100)).toBe(false)
    c.update(5.03, 100)
    expect(c.totalWh).toBeCloseTo(30)
  })

  it('counts on when openeo starts the count again at midnight, in the same session', () => {
    const c = new EnergyCounter(tmpFile(), log)
    c.update(5, 100)
    c.update(0.05, 100)
    expect(c.totalWh).toBeCloseTo(50)
  })

  it('only saves when the total changes', () => {
    const c = new EnergyCounter(tmpFile(), log)
    c.update(0, 100)
    c.save()
    c.update(0, 105)
    c.update(0, 110)
    expect(c.dirty).toBe(false)
  })
})
