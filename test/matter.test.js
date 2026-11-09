/**
 * Matter: the plugin inside Homebridge's own API, with a stand-in api.matter (test/matter-stand-in.js).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { OpenEOCharger } from '../lib/charger.js'
import { startFakeCharger } from './fake-openeo-charger.js'
import { boot, loadHomebridge, useStorage } from './harness.js'
import { makeMatter, withMatter } from './matter-stand-in.js'

let charger
let run

function cfg(extra = {}) {
  return {
    platform: 'OpenEO',
    name: 'EV Charger',
    host: charger.host,
    ...extra,
  }
}

async function start(config, { matterOn = true, ...options } = {}) {
  let m
  run = boot(config, {
    setup: (api) => {
      m = makeMatter(api, options)
      withMatter(m, matterOn)(api)
    },
    restore: (platform) => {
      for (const a of options.restored || []) {
        platform.configureMatterAccessory(a)
      }
    },
  })
  run.m = m
  await vi.waitFor(() => expect(run.platform.charger?.state.reachable).toBe(true), { timeout: 5000 })
  return run
}

function published() {
  return [
    ...run.m.registered.values(),
  ].filter(a => !a.restored)
}

beforeAll(async () => {
  await loadHomebridge()
  useStorage()
  charger = await startFakeCharger()
})

afterEach(() => {
  run?.api.signalShutdown()
  run = undefined
  charger.db.switch.on = 'False'
})

afterAll(async () => {
  await charger.stop()
})

describe('matter outlet', () => {
  it('tries again while the bridge\'s matter server is still starting, instead of giving up on matter', async () => {
    OpenEOCharger.matterRetryMs = 200
    await start(cfg(), { startingRefusals: 2 })
    await vi.waitFor(() => expect(published()).toHaveLength(1), { timeout: 3000 })
    expect(run.m.log.registerCalls).toBe(3)
    expect(run.registered[0].services.find(s => s.subtype === 'charger')).toBeUndefined()
    expect(run.log.lines.filter(l => l.startsWith('[error]'))).toEqual([])
  })

  it('publishes one outlet with power and energy, and drops the homekit outlet', async () => {
    await start(cfg())
    await vi.waitFor(() => expect(published()).toHaveLength(1))
    const [outlet] = published()
    expect(run.m.log.errors).toEqual([])
    expect(outlet.deviceType).toBe(run.m.matter.deviceTypes.OnOffOutlet)
    expect(outlet.state.electricalPowerMeasurement).toMatchObject({ voltage: 235000, activePower: 0 })
    expect(run.registered[0].services.find(s => s.subtype === 'charger')).toBeUndefined()
  })

  it('turns charge-now on from matter, and shows the watts', async () => {
    await start(cfg())
    await vi.waitFor(() => expect(published()).toHaveLength(1))
    const [outlet] = published()
    await outlet.handlers.onOff.on()
    expect(charger.settings.at(-1)).toBe('switch%3Aon=true&switch%3Aamps=16')
    await run.platform.charger.poll()
    expect(outlet.state.onOff.onOff).toBe(true)
    expect(outlet.state.electricalPowerMeasurement.activePower).toBe(Math.round(16 * 0.98 * 235) * 1000)
  })

  it('adds session energy to the lifetime total', async () => {
    await start(cfg())
    await vi.waitFor(() => expect(published()).toHaveLength(1))
    const [outlet] = published()
    const c = run.platform.charger
    const before = c.energy.totalWh
    charger.charge(1.5)
    c.lastEnergyPush = 0
    await c.poll()
    expect(c.energy.totalWh - before).toBeCloseTo(1500)
    expect(outlet.state.electricalEnergyMeasurement.cumulativeEnergyImported.energy).toBe(Math.round(c.energy.totalWh * 1000))
  })

  it('stays on homekit when matter is off for the bridge', async () => {
    await start(cfg(), { matterOn: false })
    expect(published()).toHaveLength(0)
    expect(run.registered[0].services.find(s => s.subtype === 'charger')).toBeDefined()
  })
})

describe('matter ev charger (experimental)', () => {
  it('publishes an ev charger with its required parts, and keeps the homekit outlet', async () => {
    await start(cfg({ matterDeviceType: 'evCharger' }))
    await vi.waitFor(() => expect(published()).toHaveLength(1))
    const [evse] = published()
    expect(run.m.log.errors).toEqual([])
    expect(evse.deviceType).toBe(run.m.matter.deviceTypes.EnergyEvse)
    expect(evse.parts.map(p => p.id)).toEqual(['power-source', 'meter', 'energy-management'])
    expect(evse.state.energyEvse.state).toBe(1)
    expect(run.registered[0].services.find(s => s.subtype === 'charger')).toBeDefined()
  })

  it('charges at the current asked for, and refuses less than 6 A', async () => {
    await start(cfg({ matterDeviceType: 'evCharger' }))
    await vi.waitFor(() => expect(published()).toHaveLength(1))
    const [evse] = published()
    await evse.handlers.energyEvse.enableCharging({ chargingEnabledUntil: null, minimumChargeCurrent: 6000, maximumChargeCurrent: 20000 })
    expect(charger.settings.at(-1)).toBe('switch%3Aon=true&switch%3Aamps=20')
    await expect(evse.handlers.energyEvse.enableCharging({ maximumChargeCurrent: 4000 })).rejects.toThrow('6A')
    await evse.handlers.energyEvse.disable()
    expect(charger.settings.at(-1)).toBe('switch%3Aon=false&switch%3Aamps=20')
  })

  it('keeps charging until a time more than 24.8 days away, the longest a node timer can wait', async () => {
    await start(cfg({ matterDeviceType: 'evCharger' }))
    await vi.waitFor(() => expect(published()).toHaveLength(1))
    const [evse] = published()
    // the switch writes are stubbed: fake timers would stop fetch from working
    const setSwitch = vi.spyOn(run.platform.charger, 'setSwitch').mockResolvedValue()
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout'],
    })
    try {
      const until = Math.floor(Date.now() / 1000) + 30 * 24 * 3600
      await evse.handlers.energyEvse.enableCharging({ chargingEnabledUntil: until, maximumChargeCurrent: 16000 })
      expect(setSwitch.mock.calls).toEqual([
        [true],
      ])
      await vi.advanceTimersByTimeAsync(2 ** 31)
      expect(setSwitch.mock.calls).toEqual([
        [true],
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to the outlet on a homebridge without the ev charger type', async () => {
    await start(cfg({ matterDeviceType: 'evCharger' }), { evse: false })
    await vi.waitFor(() => expect(published()).toHaveLength(1))
    expect(published()[0].deviceType).toBe(run.m.matter.deviceTypes.OnOffOutlet)
    expect(run.log.lines.some(l => l.includes('needs Homebridge 2.5'))).toBe(true)
  })
})
