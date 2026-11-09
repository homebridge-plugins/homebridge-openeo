/**
 * Matter EV charger (EnergyEvse) support - Homebridge 2.5+.
 *
 * Builds the composed accessory and translates OpenEO state into Matter's
 * EV charger attributes. Units follow Matter: mA, mV, mW, mWh, epoch seconds.
 *
 * Composition (Matter EnergyEvse device type, 0x050C):
 *   parent  EnergyEvse          energyEvse + energyEvseMode clusters
 *   part    PowerSource         wired AC mains
 *   part    ElectricalSensor    power + cumulative energy (feeds the Energy view)
 *   part    DeviceEnergyManagement   ESA type "EVSE", power forecast (none)
 */

// Matter enums (energy-evse cluster)
export const EVSE_STATE = {
  NotPluggedIn: 0,
  PluggedInNoDemand: 1,
  PluggedInDemand: 2,
  PluggedInCharging: 3,
  Fault: 6,
}
export const SUPPLY = { Disabled: 0, ChargingEnabled: 1, DisabledError: 3 }
const FAULT = { NoError: 0, Other: 0xFF }
// device-energy-management cluster
const ESA_TYPE_EVSE = 0
const ESA_STATE = { Offline: 0, Online: 1, Fault: 2 }

// energy-evse-mode: our three modes and their Matter mode tags
export const MODE = { Manual: 0, Timer: 1, Solar: 2 }
export const SUPPORTED_MODES = [
  {
    label: 'Manual',
    mode: MODE.Manual,
    modeTags: [
      { value: 0x4000 },
    ],
  }, // Manual
  {
    label: 'Timer schedule',
    mode: MODE.Timer,
    modeTags: [
      { value: 0x4001 },
    ],
  }, // TimeOfUse
  {
    label: 'Solar',
    mode: MODE.Solar,
    modeTags: [
      { value: 0x4002 },
    ],
  }, // SolarCharging
]

export const PART = { power: 'power-source', meter: 'meter', dem: 'energy-management' }

// OpenEO charger state ids (openeoCharger.py)
const OE = {
  MAINS_FAULT_START: 3,
  MAINS_FAULT: 4,
  CAR_CONNECTED_START: 9,
  CAR_CONNECTED: 10,
  CHARGING_START: 11,
  CHARGING: 12,
  SIMULATED: 99,
}

export function isFault(id) {
  return id === OE.MAINS_FAULT || id === OE.MAINS_FAULT_START
}

/** OpenEO state -> Matter EVSE StateEnum (null = unknown) */
export function evseStateEnum(s) {
  if (!s.reachable) {
    return null
  }
  const id = s.chargerStateId
  if (isFault(id)) {
    return EVSE_STATE.Fault
  }
  if (id === OE.CHARGING || id === OE.CHARGING_START || id === OE.SIMULATED) {
    return EVSE_STATE.PluggedInCharging
  }
  if (id === OE.CAR_CONNECTED || id === OE.CAR_CONNECTED_START) {
    return s.ampsRequested > 0
      ? EVSE_STATE.PluggedInDemand
      : EVSE_STATE.PluggedInNoDemand
  }
  if (id > OE.CHARGING) {
    return EVSE_STATE.PluggedInNoDemand
  } // complete / suspended / paused
  return EVSE_STATE.NotPluggedIn
}

/** Charging is "enabled" when charge-now is on or a schedule/solar is currently asking for current. */
export function chargingEnabled(s) {
  return s.switchOn || s.ampsRequested > 0
}

export function currentMode(s) {
  if (s.solarEnabled) {
    return MODE.Solar
  }
  if (s.schedulerEnabled) {
    return MODE.Timer
  }
  return MODE.Manual
}

/**
 * energyEvse attributes for the current state.
 * ctx: { chargeUntil (epoch s | null), disabledAt (epoch s), minAmps }
 */
export function evseAttributes(s, ctx) {
  const fault = s.reachable && isFault(s.chargerStateId)
  const enabled = !fault && chargingEnabled(s)
  const maxA = s.switchOn ? s.switchAmps : s.ampsRequested
  const now = Math.floor(Date.now() / 1000)
  const attrs = {
    state: evseStateEnum(s),
    supplyState: fault
      ? SUPPLY.DisabledError
      : enabled ? SUPPLY.ChargingEnabled : SUPPLY.Disabled,
    faultState: fault ? FAULT.Other : FAULT.NoError,
    // null = enabled with no end time; when disabled Matter wants a time already passed
    chargingEnabledUntil: enabled
      ? ctx.chargeUntil || null
      : ctx.disabledAt || now,
    circuitCapacity: Math.round(s.maxAmps * 1000),
    minimumChargeCurrent: enabled
      ? ctx.minAmps * 1000
      : 0,
    maximumChargeCurrent: enabled
      ? Math.round(Math.max(maxA, ctx.minAmps) * 1000)
      : 0,
    sessionId: s.sessionTs > 0
      ? s.sessionTs >>> 0
      : null,
    sessionDuration: s.sessionTs > 0
      ? Math.max(0, (s.sessionEndTs || now) - s.sessionTs)
      : null,
    sessionEnergyCharged: s.sessionTs > 0
      ? Math.round(s.sessionKWh * 1e6)
      : null,
  }
  return attrs
}

export function demAttributes(s) {
  const fault = s.reachable && isFault(s.chargerStateId)
  const volts = s.voltage > 100
    ? s.voltage
    : 230
  return {
    esaType: ESA_TYPE_EVSE,
    esaCanGenerate: false,
    esaState: !s.reachable
      ? ESA_STATE.Offline
      : fault ? ESA_STATE.Fault : ESA_STATE.Online,
    absMinPower: 0,
    absMaxPower: Math.round(s.maxAmps * volts * 1000),
  }
}

/**
 * The accessory passed to api.matter.registerPlatformAccessories().
 * power: { voltage, activeCurrent, activePower } in mV/mA/mW; energyMWh: lifetime total.
 */
export function buildEvseAccessory(matter, { uuid, name, serial, version, state, ctx, power, energyMWh, handlers }) {
  const dt = matter.deviceTypes
  return {
    UUID: uuid,
    displayName: name,
    deviceType: dt.EnergyEvse,
    manufacturer: 'EO Charging / OpenEO',
    model: 'EO Mini Pro 2 (OpenEO)',
    serialNumber: serial || `openeo-${uuid.slice(0, 8)}`,
    softwareVersion: version || undefined,
    context: {},
    clusters: {
      energyEvse: evseAttributes(state, ctx),
      energyEvseMode: {
        supportedModes: SUPPORTED_MODES,
        currentMode: currentMode(state),
      },
    },
    handlers: {
      energyEvse: {
        enableCharging: req => handlers.enableCharging(req),
        disable: () => handlers.disable(),
      },
      energyEvseMode: {
        changeToMode: req => handlers.changeToMode(req),
      },
    },
    parts: [
      {
        id: PART.power,
        displayName: `${name} Mains`,
        deviceType: dt.PowerSource,
        clusters: {
          powerSource: {
            status: 1,
            order: 0,
            description: 'Mains',
            wiredCurrentType: 0,
          },
        },
      },
      {
        id: PART.meter,
        displayName: `${name} Meter`,
        deviceType: dt.ElectricalSensor,
        clusters: {
          electricalPowerMeasurement: power,
          electricalEnergyMeasurement: {
            cumulativeEnergyImported: { energy: energyMWh },
          },
        },
      },
      {
        id: PART.dem,
        displayName: `${name} Energy Management`,
        deviceType: dt.DeviceEnergyManagement,
        clusters: {
          // forecast declared (as "none yet") turns on PowerForecastReporting, which the EVSE type requires
          deviceEnergyManagement: {
            ...demAttributes(state),
            forecast: null,
          },
        },
      },
    ],
  }
}

/** Does this Homebridge offer everything the EV charger needs? */
export function evseSupported(matter) {
  const dt = matter && matter.deviceTypes
  return !!(dt && dt.EnergyEvse && dt.PowerSource && dt.ElectricalSensor && dt.DeviceEnergyManagement)
}
