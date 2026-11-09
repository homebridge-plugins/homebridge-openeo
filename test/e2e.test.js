/**
 * The plugin inside Homebridge's own API and HAP, against a pretend OpenEO charger.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { startFakeCharger } from './fake-openeo-charger.js'
import { asHomeHubSeesIt, boot, loadHomebridge, serialise, sleep, useStorage } from './harness.js'

let charger
let run

function cfg(extra = {}) {
  return {
    platform: 'OpenEO',
    name: 'EV Charger',
    host: charger.host,
    matter: false,
    ...extra,
  }
}
function services(accessory) {
  return accessory.services.map(s => `${s.constructor.name === 'Service'
    ? s.UUID
    : s.constructor.name}:${s.displayName}`)
}
const svc = (accessory, subtype) => accessory.services.find(s => s.subtype === subtype)

async function start(config, options) {
  run = boot(config, options)
  await vi.waitFor(() => expect(run.platform.charger?.state.reachable).toBe(true), { timeout: 5000 })
  return run
}

beforeAll(async () => {
  await loadHomebridge()
  useStorage()
  charger = await startFakeCharger()
})

afterEach(() => {
  run?.api.signalShutdown()
  run = undefined
})

afterAll(async () => {
  await charger.stop()
})

describe('homekit accessories', () => {
  it('makes one accessory with the outlet, car sensor, schedule switch and problem sensor', async () => {
    await start(cfg())
    expect(run.registered).toHaveLength(1)
    const a = run.registered[0]
    expect(svc(a, 'charger')).toBeDefined()
    expect(svc(a, 'car')).toBeDefined()
    expect(svc(a, 'schedule')).toBeDefined()
    expect(svc(a, 'fault')).toBeDefined()
    expect(svc(a, 'current')).toBeUndefined()
    expect(services(a).length).toBe(5)
  })

  it('shows the charger state the way a home hub reads it, without warnings', async () => {
    await start(cfg({ exposeCurrentControl: true }))
    const { count } = await asHomeHubSeesIt(run.hap, run.registered)
    expect(count).toBe(1)
    expect(run.warnings).toEqual([])
    const a = run.registered[0]
    const { Characteristic } = run.hap
    expect(svc(a, 'car').getCharacteristic(Characteristic.OccupancyDetected).value).toBe(1)
    expect(svc(a, 'schedule').getCharacteristic(Characteristic.On).value).toBe(true)
    expect(svc(a, 'fault').getCharacteristic(Characteristic.ContactSensorState).value).toBe(0)
    expect(a.getService(run.hap.Service.AccessoryInformation).getCharacteristic(Characteristic.SerialNumber).value).toBe('EO123456')
  })

  it('turns charge-now on and off from the outlet', async () => {
    await start(cfg())
    const on = svc(run.registered[0], 'charger').getCharacteristic(run.hap.Characteristic.On)
    await on.handleSetRequest(true)
    expect(charger.settings.at(-1)).toBe('switch%3Aon=true&switch%3Aamps=16')
    await run.platform.charger.poll()
    expect(run.platform.charger.isCharging()).toBe(true)
    await on.handleSetRequest(false)
    expect(charger.settings.at(-1)).toBe('switch%3Aon=false&switch%3Aamps=16')
  })

  it('turns the charging schedule off', async () => {
    await start(cfg())
    await svc(run.registered[0], 'schedule').getCharacteristic(run.hap.Characteristic.On).handleSetRequest(false)
    expect(charger.settings.at(-1)).toBe('scheduler%3Aenabled=false')
    charger.db.scheduler.enabled = 'True'
  })

  it('opens the problem sensor on a mains fault, and closes it again', async () => {
    await start(cfg())
    const contact = svc(run.registered[0], 'fault').getCharacteristic(run.hap.Characteristic.ContactSensorState)
    charger.setFault(true)
    await run.platform.charger.poll()
    expect(contact.value).toBe(1)
    charger.setFault(false)
    await run.platform.charger.poll()
    expect(contact.value).toBe(0)
  })

  it('keeps the same accessory after a restart, and drops services that are turned off', async () => {
    await start(cfg())
    const cached = serialise(run.registered)
    run.api.signalShutdown()
    await start(cfg({ exposeScheduleSwitch: false }), { cached })
    expect(run.registered).toHaveLength(0)
    expect(svc(run.all[0], 'schedule')).toBeUndefined()
    expect(svc(run.all[0], 'charger')).toBeDefined()
  })
})

describe('polling', () => {
  it('keeps to one polling loop when a change is read back during a poll', async () => {
    await start(cfg({ pollInterval: 3 }))
    const c = run.platform.charger
    // a change's read-back poll, while the regular poll is still waiting on the charger
    await Promise.all([
      c.poll(),
      c.poll(),
    ])
    const before = charger.requests['/getstatus']
    await sleep(3500)
    expect(charger.requests['/getstatus'] - before).toBe(1)
  }, 10_000)

  it('stops asking the charger once homebridge shuts down', async () => {
    await start(cfg({ pollInterval: 3 }))
    const c = run.platform.charger
    await svc(run.registered[0], 'charger').getCharacteristic(run.hap.Characteristic.On).handleSetRequest(true)
    run.api.signalShutdown()
    const before = { ...charger.requests }
    await sleep(3500)
    expect(charger.requests).toEqual(before)
    await c.poll()
    expect(charger.requests).toEqual(before)
    charger.db.switch.on = 'False'
  }, 10_000)
})
