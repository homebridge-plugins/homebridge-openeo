'use strict';

/**
 * homebridge-openeo
 *
 * Exposes an EO Mini Pro 2 / EO Smart Home Hub charger running OpenEO
 * (https://github.com/minceheid/openeo) to Apple Home via Homebridge.
 *
 * Talks only to the charger's local HTTP API:
 *   GET  /getstatus    live charger state + metrics
 *   GET  /getconfig    running module configuration (switch, scheduler, ...)
 *   POST /setsettings  form-encoded "module:key=value" pairs
 *
 * OpenEO takes the MAXIMUM current requested by any of its modules. The
 * "switch" module is the manual override shown on the OpenEO home page:
 *   switch:on=true   -> charge now at switch:amps
 *   switch:on=false  -> fall back to timers / solar (if any)
 *
 * Two ways the main charger control can be published:
 *   - Matter (Homebridge >= 2.2 with a `matter` block on this bridge):
 *     an OnOffOutlet with ElectricalPowerMeasurement + ElectricalEnergyMeasurement,
 *     which Apple Home shows in its Energy view.
 *   - HAP (fallback / default): an Outlet with Eve power characteristics.
 * The car sensor, schedule switch and current control are always HAP.
 */

const fs = require('fs');
const path = require('path');
const { discover } = require('./lib/discovery');
const evse = require('./lib/evse');

const PLUGIN_NAME = 'homebridge-openeo';
const PLATFORM_NAME = 'OpenEO';

const MIN_AMPS = 6;
const MAX_AMPS = 32;

// OpenEO charger state ids (openeoCharger.py CHARGER_STATES)
const STATE = {
  MAINS_FAULT_START: 3,
  MAINS_FAULT: 4,
  CAR_CONNECTED_START: 9,
  CHARGING_START: 11,
  CHARGING: 12,
  SIMULATED: 99,
};

let hap;
let Service;
let Characteristic;
let EveChars;

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, OpenEOPlatform);
};

/* ------------------------------------------------------------------------ */
/* Eve custom characteristics (power metering shows in the Eve app)          */
/* ------------------------------------------------------------------------ */
function buildEveCharacteristics(hapRef) {
  const make = (name, uuid, unit, maxValue) => {
    const C = class extends hapRef.Characteristic {
      constructor() {
        super(name, uuid, {
          format: hapRef.Formats.FLOAT,
          unit,
          minValue: 0,
          maxValue,
          minStep: 0.01,
          perms: [hapRef.Perms.PAIRED_READ, hapRef.Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
      }
    };
    C.UUID = uuid;
    return C;
  };
  return {
    Watts: make('Consumption', 'E863F10D-079E-48FF-8F27-9C2605A29F52', 'W', 100000),
    Volts: make('Voltage', 'E863F10A-079E-48FF-8F27-9C2605A29F52', 'V', 1000),
    Amps: make('Electric Current', 'E863F126-079E-48FF-8F27-9C2605A29F52', 'A', 1000),
    KWh: make('Total Consumption', 'E863F10C-079E-48FF-8F27-9C2605A29F52', 'kWh', 1000000),
  };
}

/* ------------------------------------------------------------------------ */
/* Small HTTP client for the OpenEO API                                     */
/* ------------------------------------------------------------------------ */
class OpenEOClient {
  constructor(baseUrl, timeoutMs) {
    this.setBaseUrl(baseUrl);
    this.timeoutMs = timeoutMs;
  }

  setBaseUrl(baseUrl) {
    this.baseUrl = baseUrl ? baseUrl.replace(/\/+$/, '') : null;
  }

  async request(urlPath, options = {}) {
    if (!this.baseUrl) {
      throw new Error('Charger address not known yet (auto-discovery has not found it)');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.baseUrl + urlPath, { ...options, signal: controller.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${urlPath}`);
      }
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(`Timed out after ${this.timeoutMs}ms calling ${urlPath}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  getStatus() {
    return this.request('/getstatus');
  }

  getConfig() {
    return this.request('/getconfig');
  }

  setSettings(settings) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(settings)) {
      body.append(k, String(v));
    }
    return this.request('/setsettings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  }
}

const toBaseUrl = (host) => (/^https?:\/\//i.test(host) ? host : `http://${host}`);

const toBool = (v) => v === true || v === 1 || (typeof v === 'string' && (v.toLowerCase() === 'true' || v === '1'));
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/* ------------------------------------------------------------------------ */
/* Lifetime energy counter                                                  */
/* OpenEO only reports kWh for the current session (reset when the car is   */
/* unplugged). Matter wants a cumulative, never-decreasing meter, so we      */
/* accumulate session deltas and persist the total.                          */
/* ------------------------------------------------------------------------ */
class EnergyCounter {
  constructor(file, log) {
    this.file = file;
    this.log = log;
    this.data = { totalWh: 0, lastSessionKWh: null, lastSessionTs: null };
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Number.isFinite(saved.totalWh)) this.data = { ...this.data, ...saved };
    } catch {
      /* first run */
    }
    this.dirty = false;
  }

  get totalWh() {
    return this.data.totalWh;
  }

  /** Feed the latest session reading; returns true if the total changed. */
  update(sessionKWh, sessionTs) {
    const d = this.data;
    let delta = 0;
    const newSession = d.lastSessionKWh === null
      || (sessionTs && d.lastSessionTs && sessionTs !== d.lastSessionTs)
      || sessionKWh < d.lastSessionKWh - 0.001;

    if (d.lastSessionKWh === null) {
      delta = 0; // first ever reading: don't count energy from before we were watching
    } else if (newSession) {
      delta = sessionKWh; // new session started since last poll
    } else {
      delta = sessionKWh - d.lastSessionKWh;
    }

    d.lastSessionKWh = sessionKWh;
    d.lastSessionTs = sessionTs || d.lastSessionTs;

    if (delta > 0 && delta < 200) {
      d.totalWh += delta * 1000;
      this.dirty = true;
      return true;
    }
    if (newSession) this.dirty = true;
    return false;
  }

  save() {
    if (!this.dirty) return;
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data));
      this.dirty = false;
    } catch (err) {
      this.log.warn(`Could not save energy total: ${err.message}`);
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Platform                                                                 */
/* ------------------------------------------------------------------------ */
class OpenEOPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.cachedAccessories = [];
    this.cachedMatterAccessories = [];

    hap = api.hap;
    Service = hap.Service;
    Characteristic = hap.Characteristic;
    EveChars = EveChars || buildEveCharacteristics(hap);

    api.on('didFinishLaunching', () => {
      this.setup().catch((err) => this.log.error(`Setup failed: ${err.stack || err.message}`));
    });
  }

  configureAccessory(accessory) {
    this.cachedAccessories.push(accessory);
  }

  configureMatterAccessory(accessory) {
    this.cachedMatterAccessories.push(accessory);
  }

  matterAvailable() {
    return typeof this.api.isMatterEnabled === 'function' && this.api.isMatterEnabled() && !!this.api.matter;
  }

  async setup() {
    const host = String(this.config.host || '').trim();
    const autoDiscover = !host || host.toLowerCase() === 'auto';
    const baseUrl = autoDiscover ? null : toBaseUrl(host);
    // Auto mode keys on "auto" so the accessory survives the charger's IP changing
    const key = autoDiscover ? 'auto' : baseUrl;
    const name = this.config.name || 'EV Charger';
    const uuid = hap.uuid.generate(`openeo:${key}`);

    const wantMatter = this.config.matter !== false;
    const useMatter = wantMatter && this.matterAvailable();

    if (wantMatter && !useMatter) {
      this.log.info('Matter is not enabled on this bridge - using HomeKit (HAP) only. '
        + 'Add a "matter" block to this bridge to get Apple Home Energy reporting (Homebridge 2.2+).');
    }

    // Which Matter device type to publish: the proven outlet, or the experimental EV charger (Homebridge 2.5+)
    let matterType = this.config.matterDeviceType === 'evCharger' ? 'evCharger' : 'outlet';
    if (useMatter && matterType === 'evCharger' && !evse.evseSupported(this.api.matter)) {
      this.log.warn('EV charger device type needs Homebridge 2.5 or later - publishing as a Matter outlet instead.');
      matterType = 'outlet';
    }
    // A different UUID per type, so switching type re-registers cleanly
    const matterUuid = hap.uuid.generate(matterType === 'evCharger' ? `openeo-matter-evse:${key}` : `openeo-matter:${key}`);

    // Clean up Matter accessories we no longer want
    if (this.api.matter && this.cachedMatterAccessories.length) {
      const staleMatter = this.cachedMatterAccessories.filter((a) => !useMatter || a.UUID !== matterUuid);
      if (staleMatter.length) {
        await this.api.matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleMatter).catch((e) =>
          this.log.warn(`Could not remove old Matter accessory: ${e.message}`));
      }
    }

    // HAP accessory
    let accessory = this.cachedAccessories.find((a) => a.UUID === uuid);
    const isNew = !accessory;
    if (isNew) {
      accessory = new this.api.platformAccessory(name, uuid, hap.Categories.OUTLET);
    }
    const stale = this.cachedAccessories.filter((a) => a.UUID !== uuid);
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }

    const storage = this.api.user.storagePath();
    this.charger = new OpenEOCharger(this, {
      accessory, baseUrl, name, matterUuid,
      useMatter,
      matterType,
      autoDiscover,
      energyFile: path.join(storage, `openeo-energy-${uuid.slice(0, 8)}.json`),
      discoveryFile: path.join(storage, 'openeo-discovered.json'),
      runtimeFile: path.join(storage, 'openeo-runtime.json'),
    });

    if (isNew) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    } else {
      this.api.updatePlatformAccessories([accessory]);
    }

    if (useMatter) {
      await this.charger.registerMatter();
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Charger                                                                  */
/* ------------------------------------------------------------------------ */
class OpenEOCharger {
  constructor(platform, opts) {
    this.platform = platform;
    this.api = platform.api;
    this.log = platform.log;
    this.accessory = opts.accessory;
    this.name = opts.name;
    this.matterUuid = opts.matterUuid;
    this.useMatter = opts.useMatter;
    this.matterType = opts.matterType || 'outlet';

    const cfg = platform.config;
    this.pollMs = clamp(num(Number(cfg.pollInterval), 10), 3, 300) * 1000;
    this.defaultAmps = clamp(num(Number(cfg.defaultAmps), MAX_AMPS), MIN_AMPS, MAX_AMPS);
    this.exposeCarSensor = cfg.exposeCarSensor !== false;
    this.exposeScheduleSwitch = cfg.exposeScheduleSwitch !== false;
    this.exposeCurrentControl = cfg.exposeCurrentControl === true;
    this.exposeEnergy = cfg.exposeEnergy !== false;
    this.exposeFaultSensor = cfg.exposeFaultSensor !== false;
    this.offlineAlertMs = clamp(num(Number(cfg.offlineAlertMinutes), 5), 1, 1440) * 60000;
    this.autoDiscover = opts.autoDiscover;
    this.discoveryFile = opts.discoveryFile;
    this.runtimeFile = opts.runtimeFile;
    this.discoverySubnets = Array.isArray(cfg.discoverySubnets) ? cfg.discoverySubnets.filter(Boolean)
      : String(cfg.discoverySubnets || '').split(/[\s,]+/).filter(Boolean);
    this.discoveryPort = num(Number(cfg.discoveryPort), 80); // for testing only
    // With Matter active the outlet lives on Matter; a second HAP outlet would be a duplicate tile.
    // The EV charger type is experimental: keep the proven HomeKit on/off outlet alongside it
    this.hapOutletEnabled = !this.useMatter || cfg.hapOutletWithMatter === true || this.matterType === 'evCharger';
    this.evseCtx = { chargeUntil: null, disabledAt: Math.floor(Date.now() / 1000), minAmps: MIN_AMPS };
    this.chargeUntilTimer = null;

    let baseUrl = opts.baseUrl;
    if (this.autoDiscover) {
      try {
        const cached = JSON.parse(fs.readFileSync(this.discoveryFile, 'utf8'));
        if (cached.host) baseUrl = toBaseUrl(cached.host);
      } catch {
        /* nothing cached yet */
      }
    }
    this.client = new OpenEOClient(baseUrl, clamp(num(Number(cfg.timeout), 5), 1, 30) * 1000);
    this.lastSeen = 0;
    this.startedAt = Date.now();
    this.lastDiscovery = 0;
    this.discovering = null;
    this.fault = { active: false, reason: '' };
    this.energy = new EnergyCounter(opts.energyFile, this.log);

    this.state = {
      reachable: false,
      switchOn: false,
      switchAmps: this.defaultAmps,
      schedulerEnabled: false,
      solarEnabled: false,
      ampsRequested: 0,
      sessionTs: 0,
      sessionEndTs: 0,
      maxAmps: MAX_AMPS,
      chargerStateId: 0,
      chargerState: '',
      powerW: 0,
      voltage: 0,
      vehicleAmps: 0,
      sessionKWh: 0,
      serial: '',
      version: '',
    };
    this.pollTimer = null;
    this.pendingWriteUntil = 0;
    this.matterReady = false;
    this.matterLast = {};
    this.lastEnergyPush = 0;

    this.setupServices();
    this.log.info(`OpenEO charger "${this.name}" at ${this.client.baseUrl || '(auto-discover)'}, polling every ${this.pollMs / 1000}s`
      + (this.useMatter ? (this.matterType === 'evCharger' ? ' (Matter EV charger - experimental)' : ' (Matter energy outlet enabled)') : ''));
    this.firstPoll = (this.autoDiscover && !this.client.baseUrl ? this.runDiscovery() : Promise.resolve())
      .then(() => this.poll());
  }

  /* ---------------------------- HAP services ---------------------------- */
  setupServices() {
    const acc = this.accessory;

    acc.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'EO Charging / OpenEO')
      .setCharacteristic(Characteristic.Model, 'EO Mini Pro 2 (OpenEO)');

    // Main control: Outlet. On = manual "charge now", InUse = actively charging.
    this.outlet = this.syncService(this.hapOutletEnabled, Service.Outlet, this.name, 'charger');
    if (this.outlet) {
      this.outlet.getCharacteristic(Characteristic.On)
        .onGet(() => this.guard(() => this.state.switchOn))
        .onSet((v) => this.hapSet(() => this.setSwitch(!!v)));
      this.outlet.getCharacteristic(Characteristic.OutletInUse)
        .onGet(() => this.guard(() => this.isCharging()));

      for (const C of [EveChars.Watts, EveChars.Volts, EveChars.Amps, EveChars.KWh]) {
        const existing = this.outlet.characteristics.find((c) => c.UUID === C.UUID);
        if (this.exposeEnergy && !existing) {
          this.outlet.addOptionalCharacteristic(C);
          this.outlet.addCharacteristic(C);
        } else if (!this.exposeEnergy && existing) {
          this.outlet.removeCharacteristic(existing);
        }
      }
    }

    this.carSensor = this.syncService(this.exposeCarSensor, Service.OccupancySensor, 'Car Connected', 'car');
    if (this.carSensor) {
      this.carSensor.getCharacteristic(Characteristic.OccupancyDetected)
        .onGet(() => this.guard(() => (this.isCarConnected() ? 1 : 0)));
    }

    this.scheduleSwitch = this.syncService(this.exposeScheduleSwitch, Service.Switch, 'Charging Schedule', 'schedule');
    if (this.scheduleSwitch) {
      this.scheduleSwitch.getCharacteristic(Characteristic.On)
        .onGet(() => this.guard(() => this.state.schedulerEnabled))
        .onSet((v) => this.hapSet(() => this.setScheduler(!!v)));
    }

    // Fault sensor: "open" = problem (mains fault, or charger offline too long).
    // Not guarded: it must keep answering while the charger is unreachable.
    this.faultSensor = this.syncService(this.exposeFaultSensor, Service.ContactSensor, 'Charger Problem', 'fault');
    if (this.faultSensor) {
      this.faultSensor.getCharacteristic(Characteristic.ContactSensorState)
        .onGet(() => (this.fault.active ? 1 : 0));
      this.faultSensor.getCharacteristic(Characteristic.StatusFault)
        .onGet(() => (this.fault.active ? 1 : 0));
    }

    this.currentFan = this.syncService(this.exposeCurrentControl, Service.Fanv2, 'Charge Current', 'current');
    if (this.currentFan) {
      this.currentFan.getCharacteristic(Characteristic.Active)
        .onGet(() => this.guard(() => (this.state.switchOn ? 1 : 0)))
        .onSet((v) => this.hapSet(() => this.setSwitch(v === 1)));
      this.currentFan.getCharacteristic(Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
        .onGet(() => this.guard(() => this.ampsToPercent(this.state.switchAmps)))
        .onSet((v) => this.hapSet(() => this.setAmpsFromPercent(Number(v))));
    }
  }

  syncService(enabled, type, name, subtype) {
    let svc = this.accessory.getServiceById(type, subtype);
    if (!enabled) {
      if (svc) this.accessory.removeService(svc);
      return null;
    }
    if (!svc) svc = this.accessory.addService(type, name, subtype);
    this.setDisplayName(svc, name);
    return svc;
  }

  setDisplayName(svc, name) {
    svc.setCharacteristic(Characteristic.Name, name);
    if (Characteristic.ConfiguredName) {
      if (!svc.testCharacteristic(Characteristic.ConfiguredName)) {
        svc.addOptionalCharacteristic(Characteristic.ConfiguredName);
      }
      const cn = svc.getCharacteristic(Characteristic.ConfiguredName);
      if (!cn.value) cn.updateValue(name);
    }
  }

  /* ---------------------------- Matter ---------------------------------- */
  async registerMatter() {
    if (this.matterType === 'evCharger') return this.registerMatterEvse();
    const matter = this.api.matter;
    await this.firstPoll; // so we have serial number and initial values
    const s = this.state;
    try {
      await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [{
        UUID: this.matterUuid,
        displayName: this.name,
        deviceType: matter.deviceTypes.OnOffOutlet,
        manufacturer: 'EO Charging / OpenEO',
        model: 'EO Mini Pro 2 (OpenEO)',
        serialNumber: s.serial || `openeo-${this.matterUuid.slice(0, 8)}`,
        softwareVersion: s.version || undefined,
        context: {},
        clusters: {
          onOff: { onOff: s.switchOn },
          electricalPowerMeasurement: this.matterPowerState(),
          electricalEnergyMeasurement: {
            cumulativeEnergyImported: { energy: Math.round(this.energy.totalWh * 1000) },
          },
        },
        handlers: {
          onOff: {
            on: () => this.setSwitch(true),
            off: () => this.setSwitch(false),
            toggle: () => this.setSwitch(!this.state.switchOn),
          },
        },
      }]);
      this.matterReady = true;
      this.matterLast = { onOff: s.switchOn };
      this.lastEnergyPush = Date.now();
      this.log.info(`Published "${this.name}" as a Matter outlet with power & energy measurement`);
    } catch (err) {
      this.log.error(`Matter registration failed (${err.message}) - falling back to a HomeKit outlet`);
      this.useMatter = false;
      this.hapOutletEnabled = true;
      this.setupServices();
      this.api.updatePlatformAccessories([this.accessory]);
      this.updateCharacteristics();
    }
  }

  async registerMatterEvse() {
    const matter = this.api.matter;
    await this.firstPoll;
    const s = this.state;
    try {
      await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [evse.buildEvseAccessory(matter, {
        uuid: this.matterUuid,
        name: this.name,
        serial: s.serial,
        version: s.version,
        state: s,
        ctx: this.evseCtx,
        power: this.matterPowerState(),
        energyMWh: Math.round(this.energy.totalWh * 1000),
        handlers: {
          enableCharging: (req) => this.evseEnableCharging(req),
          disable: () => this.evseDisable(),
          changeToMode: (req) => this.evseChangeMode(req),
        },
      })]);
      this.matterReady = true;
      this.matterLast = { evse: this.evseKey(), mode: evse.currentMode(s), lastEvsePush: Date.now() };
      this.lastEnergyPush = Date.now();
      this.log.info(`Published "${this.name}" as a Matter EV charger (experimental) with power & energy measurement`);
    } catch (err) {
      this.log.error(`Matter EV charger registration failed (${err.message}). `
        + 'Set "Matter device type" back to Outlet. The HomeKit outlet keeps working meanwhile.');
    }
  }

  /* ----- EV charger commands from Apple Home / other Matter controllers ----- */
  async evseEnableCharging(req = {}) {
    const now = Math.floor(Date.now() / 1000);
    const until = req.chargingEnabledUntil === null || req.chargingEnabledUntil === undefined
      ? null : Number(req.chargingEnabledUntil);
    if (until !== null && until <= now) {
      return this.evseDisable();
    }
    const maxMa = Number(req.maximumChargeCurrent);
    let amps = Number.isFinite(maxMa) && maxMa > 0 ? Math.floor(maxMa / 1000) : this.state.switchAmps;
    if (amps < MIN_AMPS) {
      throw new Error(`Maximum current ${amps}A is below the charger's ${MIN_AMPS}A minimum`);
    }
    amps = clamp(amps, MIN_AMPS, Math.min(MAX_AMPS, this.state.maxAmps));
    this.state.switchAmps = amps;
    await this.setSwitch(true);
    if (until !== null) {
      this.evseCtx.chargeUntil = until;
      const ms = Math.min((until - now) * 1000, 2 ** 31 - 1);
      this.chargeUntilTimer = setTimeout(() => {
        this.log.info('Charging window from Matter has ended - turning charge-now off');
        this.setSwitch(false).catch(() => {});
      }, ms);
      this.log.info(`Charging enabled until ${new Date(until * 1000).toLocaleString()}`);
    }
  }

  async evseDisable() {
    await this.setSwitch(false);
  }

  async evseChangeMode(req = {}) {
    const mode = Number(req.newMode);
    const settings = {
      [evse.MODE.Manual]: { 'scheduler:enabled': false, 'loadmanagement:solar_enable': false },
      [evse.MODE.Timer]: { 'scheduler:enabled': true, 'loadmanagement:solar_enable': false },
      [evse.MODE.Solar]: { 'loadmanagement:solar_enable': true },
    }[mode];
    if (!settings) throw new Error(`Unknown mode ${req.newMode}`);
    const label = evse.SUPPORTED_MODES.find((m) => m.mode === mode).label;
    if ('scheduler:enabled' in settings) this.state.schedulerEnabled = settings['scheduler:enabled'];
    this.state.solarEnabled = settings['loadmanagement:solar_enable'];
    this.updateCharacteristics();
    await this.write(settings, `charging mode "${label}"`);
  }

  /** Change-detection key for the EV charger attributes (sessionDuration excluded: it ticks every poll). */
  evseKey() {
    const a = evse.evseAttributes(this.state, this.evseCtx);
    delete a.sessionDuration;
    return JSON.stringify(a);
  }

  async pushMatterEvse(energyChanged) {
    const matter = this.api.matter;
    const s = this.state;
    const uuid = this.matterUuid;
    const L = this.matterLast;

    // Track when charging stopped being allowed (Matter wants that time while disabled)
    const enabled = s.reachable && !evse.isFault(s.chargerStateId) && (s.switchOn || s.ampsRequested > 0);
    if (L.enabled && !enabled) this.evseCtx.disabledAt = Math.floor(Date.now() / 1000);
    L.enabled = enabled;

    const key = this.evseKey();
    if (key !== L.evse || Date.now() - (L.lastEvsePush || 0) >= 60000) {
      await matter.updateAccessoryState(uuid, 'energyEvse', evse.evseAttributes(s, this.evseCtx));
      L.evse = key;
      L.lastEvsePush = Date.now();
    }
    const mode = evse.currentMode(s);
    if (mode !== L.mode) {
      await matter.updateAccessoryState(uuid, 'energyEvseMode', { currentMode: mode });
      L.mode = mode;
    }
    const dem = JSON.stringify(evse.demAttributes(s));
    if (dem !== L.dem) {
      await matter.updateAccessoryState(uuid, 'deviceEnergyManagement', evse.demAttributes(s), evse.PART.dem);
      L.dem = dem;
    }
    const power = this.matterPowerState();
    const pkey = JSON.stringify(power);
    if (pkey !== L.power) {
      await matter.updateAccessoryState(uuid, 'electricalPowerMeasurement', power, evse.PART.meter);
      L.power = pkey;
    }
    if (energyChanged && Date.now() - this.lastEnergyPush >= 60000) {
      await matter.updateAccessoryState(uuid, 'electricalEnergyMeasurement', {
        cumulativeEnergyImported: { energy: Math.round(this.energy.totalWh * 1000) },
      }, evse.PART.meter);
      this.lastEnergyPush = Date.now();
      this.pendingEnergy = false;
    } else if (energyChanged) {
      this.pendingEnergy = true;
    }
  }

  /** Matter units: mV, mA, mW (nullable = no reading). */
  matterPowerState() {
    const s = this.state;
    if (!s.reachable) return { voltage: null, activeCurrent: null, activePower: null };
    return {
      voltage: Math.round(s.voltage * 1000),
      activeCurrent: Math.round(s.vehicleAmps * 1000),
      activePower: Math.round(s.powerW * 1000),
    };
  }

  async pushMatter(energyChanged) {
    if (!this.matterReady) return;
    if (this.matterType === 'evCharger') {
      try {
        await this.pushMatterEvse(energyChanged);
      } catch (err) {
        this.log.debug(`Matter EV charger update failed: ${err.message}`);
      }
      return;
    }
    const matter = this.api.matter;
    const s = this.state;
    try {
      if (this.matterLast.onOff !== s.switchOn) {
        await matter.updateAccessoryState(this.matterUuid, 'onOff', { onOff: s.switchOn });
        this.matterLast.onOff = s.switchOn;
      }
      const power = this.matterPowerState();
      const key = JSON.stringify(power);
      if (this.matterLast.power !== key) {
        await matter.updateAccessoryState(this.matterUuid, 'electricalPowerMeasurement', power);
        this.matterLast.power = key;
      }
      // Energy events aren't throttled by matter.js, so push at most once a minute
      if (energyChanged && Date.now() - this.lastEnergyPush >= 60000) {
        await matter.updateAccessoryState(this.matterUuid, 'electricalEnergyMeasurement', {
          cumulativeEnergyImported: { energy: Math.round(this.energy.totalWh * 1000) },
        });
        this.lastEnergyPush = Date.now();
        this.pendingEnergy = false;
      } else if (energyChanged) {
        this.pendingEnergy = true;
      }
    } catch (err) {
      this.log.debug(`Matter state update failed: ${err.message}`);
    }
  }

  /* ---------------------------- helpers --------------------------------- */
  guard(fn) {
    if (!this.state.reachable) {
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return fn();
  }

  async hapSet(fn) {
    try {
      await fn();
    } catch {
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  isCharging() {
    const id = this.state.chargerStateId;
    return id === STATE.CHARGING || id === STATE.CHARGING_START || id === STATE.SIMULATED;
  }

  isCarConnected() {
    return this.state.chargerStateId >= STATE.CAR_CONNECTED_START;
  }

  ampsToPercent(amps) {
    return Math.round((clamp(amps, 0, MAX_AMPS) / MAX_AMPS) * 100);
  }

  percentToAmps(pct) {
    const amps = Math.round((clamp(pct, 0, 100) / 100) * MAX_AMPS);
    return clamp(amps, MIN_AMPS, Math.min(MAX_AMPS, this.state.maxAmps));
  }

  /* ---------------------------- writes ---------------------------------- */
  async write(settings, description) {
    try {
      this.log.info(`Setting ${description}`);
      this.pendingWriteUntil = Date.now() + 3000; // ignore stale poll results briefly
      await this.client.setSettings(settings);
      setTimeout(() => this.poll(), 1500);
    } catch (err) {
      this.log.error(`Failed to set ${description}: ${err.message}`);
      this.pendingWriteUntil = 0;
      setTimeout(() => this.poll(), 500);
      throw err;
    }
  }

  async setSwitch(on) {
    clearTimeout(this.chargeUntilTimer);
    this.evseCtx.chargeUntil = null;
    const amps = clamp(this.state.switchAmps || this.defaultAmps, MIN_AMPS, MAX_AMPS);
    this.state.switchOn = on;
    this.updateCharacteristics();
    await this.write({ 'switch:on': on, 'switch:amps': amps }, on ? `charging ON at ${amps}A` : 'charging OFF (back to schedule)');
  }

  async setScheduler(enabled) {
    this.state.schedulerEnabled = enabled;
    this.updateCharacteristics();
    await this.write({ 'scheduler:enabled': enabled }, `charging schedule ${enabled ? 'ENABLED' : 'DISABLED'}`);
  }

  async setAmpsFromPercent(pct) {
    if (pct <= 0) {
      return this.setSwitch(false);
    }
    const amps = this.percentToAmps(pct);
    this.state.switchAmps = amps;
    this.state.switchOn = true;
    this.updateCharacteristics();
    clearTimeout(this.ampsTimer);
    return new Promise((resolve, reject) => {
      this.ampsTimer = setTimeout(() => {
        this.write({ 'switch:on': true, 'switch:amps': amps }, `charge current ${amps}A`)
          .then(resolve, reject);
      }, 600);
    });
  }

  /* ---------------------------- polling --------------------------------- */
  async poll() {
    clearTimeout(this.pollTimer);
    let energyChanged = false;
    try {
      const [status, config] = await Promise.all([this.client.getStatus(), this.client.getConfig()]);

      if (!this.state.reachable) this.log.info(`Connected to OpenEO charger at ${this.client.baseUrl}`);
      this.state.reachable = true;
      this.lastSeen = Date.now();

      const s = this.state;
      s.chargerStateId = num(status.eo_charger_state_id);
      s.chargerState = status.eo_charger_state || '';
      s.powerW = num(status.eo_power_delivered) * 1000;
      s.voltage = num(status.eo_live_voltage);
      s.vehicleAmps = num(status.eo_current_vehicle);
      s.sessionKWh = num(status.eo_session_kwh);
      s.maxAmps = clamp(num(status.eo_overall_limit_current, MAX_AMPS), MIN_AMPS, MAX_AMPS);
      s.ampsRequested = num(status.eo_amps_requested);
      const ts = num(status.eo_session_timestamp);
      if (ts && ts !== s.sessionTs) {
        s.sessionTs = ts;
        s.sessionEndTs = 0;
      }
      // Freeze the session's duration once the car is unplugged
      if (s.sessionTs && s.chargerStateId < STATE.CAR_CONNECTED_START && !evse.isFault(s.chargerStateId)) {
        if (!s.sessionEndTs) s.sessionEndTs = Math.floor(Date.now() / 1000);
      } else {
        s.sessionEndTs = 0;
      }
      if (status.eo_serial_number) s.serial = String(status.eo_serial_number);
      if (status.app_version) s.version = String(status.app_version).replace(/^v/, '');

      energyChanged = this.energy.update(s.sessionKWh, num(status.eo_session_timestamp)) || this.pendingEnergy;
      this.energy.save();

      if (Date.now() > this.pendingWriteUntil) {
        const sw = config.switch || {};
        s.switchOn = toBool(sw.on);
        const amps = Number(sw.amps);
        if (Number.isFinite(amps) && amps > 0) s.switchAmps = amps;
        s.schedulerEnabled = toBool((config.scheduler || {}).enabled);
        s.solarEnabled = toBool((config.loadmanagement || {}).solar_enable);
      }

      this.updateAccessoryInfo();
      this.updateCharacteristics();
      this.log.debug(`state=${s.chargerState}(${s.chargerStateId}) switch=${s.switchOn}@${s.switchAmps}A `
        + `sched=${s.schedulerEnabled} power=${s.powerW}W total=${(this.energy.totalWh / 1000).toFixed(2)}kWh`);
    } catch (err) {
      if (this.state.reachable) {
        this.log.warn(`Lost contact with OpenEO charger: ${err.message}`);
      } else {
        this.log.debug(`OpenEO charger unreachable: ${err.message}`);
      }
      this.state.reachable = false;
      this.markUnreachable();
      this.maybeRediscover();
    } finally {
      this.evaluateFault();
      this.writeRuntime();
      await this.pushMatter(energyChanged);
      this.pollTimer = setTimeout(() => this.poll(), this.pollMs);
    }
  }

  updateAccessoryInfo() {
    if (this.infoSet || !this.state.serial) return;
    const info = this.accessory.getService(Service.AccessoryInformation);
    info.updateCharacteristic(Characteristic.SerialNumber, this.state.serial);
    if (this.state.version) info.updateCharacteristic(Characteristic.FirmwareRevision, this.state.version);
    this.infoSet = true;
  }

  updateCharacteristics() {
    const s = this.state;
    if (this.outlet) {
      this.outlet.updateCharacteristic(Characteristic.On, s.switchOn);
      this.outlet.updateCharacteristic(Characteristic.OutletInUse, this.isCharging());
      if (this.exposeEnergy) {
        this.outlet.updateCharacteristic(EveChars.Watts, Math.round(s.powerW * 10) / 10);
        this.outlet.updateCharacteristic(EveChars.Volts, Math.round(s.voltage * 10) / 10);
        this.outlet.updateCharacteristic(EveChars.Amps, Math.round(s.vehicleAmps * 100) / 100);
        this.outlet.updateCharacteristic(EveChars.KWh, Math.round(s.sessionKWh * 100) / 100);
      }
    }
    if (this.carSensor) {
      this.carSensor.updateCharacteristic(Characteristic.OccupancyDetected, this.isCarConnected() ? 1 : 0);
    }
    if (this.scheduleSwitch) {
      this.scheduleSwitch.updateCharacteristic(Characteristic.On, s.schedulerEnabled);
    }
    if (this.currentFan) {
      this.currentFan.updateCharacteristic(Characteristic.Active, s.switchOn ? 1 : 0);
      this.currentFan.updateCharacteristic(Characteristic.RotationSpeed, this.ampsToPercent(s.switchAmps));
    }
  }

  /* ---------------------------- discovery ------------------------------- */
  runDiscovery() {
    if (this.discovering) return this.discovering;
    this.lastDiscovery = Date.now();
    this.log.info('Searching the network for an OpenEO charger...');
    this.discovering = discover({
      subnets: this.discoverySubnets,
      log: this.log,
      port: this.discoveryPort,
      skipLocalSubnets: this.discoveryPort !== 80,
      skipLocalName: this.discoveryPort !== 80,
    }).then((found) => {
      if (!found.length) {
        this.log.warn('No OpenEO charger found. If it is on another VLAN/subnet, add it under "Extra subnets to search", '
          + 'or set the charger address directly.');
        return;
      }
      if (found.length > 1) {
        this.log.warn(`Found ${found.length} OpenEO chargers (${found.map((f) => f.host).join(', ')}) - using the first. `
          + 'Set the address explicitly to choose.');
      }
      const hit = found[0];
      this.log.info(`Found OpenEO charger ${hit.serial ? `(serial ${hit.serial}) ` : ''}at ${hit.host}`);
      this.client.setBaseUrl(toBaseUrl(hit.host));
      try {
        fs.writeFileSync(this.discoveryFile, JSON.stringify({ host: hit.host, serial: hit.serial, at: new Date().toISOString() }));
      } catch (err) {
        this.log.warn(`Could not save discovered address: ${err.message}`);
      }
    }).catch((err) => {
      this.log.warn(`Discovery failed: ${err.message}`);
    }).finally(() => {
      this.discovering = null;
    });
    return this.discovering;
  }

  maybeRediscover() {
    if (!this.autoDiscover || this.discovering) return;
    const offlineFor = Date.now() - (this.lastSeen || this.startedAt);
    const sinceLast = Date.now() - this.lastDiscovery;
    // Charger missing for 2+ minutes (maybe a new IP): search again, at most every 5 minutes
    if (offlineFor >= 120000 && sinceLast >= 300000) {
      this.runDiscovery().then(() => this.poll());
    }
  }

  /* ---------------------------- fault ----------------------------------- */
  evaluateFault() {
    let reason = '';
    if (!this.state.reachable) {
      const offlineFor = Date.now() - (this.lastSeen || this.startedAt);
      if (offlineFor >= this.offlineAlertMs) {
        reason = `Charger offline for ${Math.round(offlineFor / 60000)} min`;
      }
    } else if (this.state.chargerStateId === STATE.MAINS_FAULT || this.state.chargerStateId === STATE.MAINS_FAULT_START) {
      reason = 'Charger reports a mains fault';
    }
    const active = !!reason;
    if (active !== this.fault.active) {
      if (active) this.log.warn(`Charger problem: ${reason}`);
      else this.log.info('Charger problem cleared');
    }
    this.fault = { active, reason };
    if (this.faultSensor) {
      this.faultSensor.updateCharacteristic(Characteristic.ContactSensorState, active ? 1 : 0);
      this.faultSensor.updateCharacteristic(Characteristic.StatusFault, active ? 1 : 0);
    }
  }

  /** Small status file read by the Homebridge UI page. */
  writeRuntime() {
    const s = this.state;
    const data = {
      name: this.name,
      host: this.client.baseUrl,
      autoDiscover: this.autoDiscover,
      reachable: s.reachable,
      lastSeen: this.lastSeen ? new Date(this.lastSeen).toISOString() : null,
      fault: this.fault,
      chargerState: s.chargerState,
      chargerStateId: s.chargerStateId,
      lifetimeKWh: Math.round(this.energy.totalWh) / 1000,
      matter: !!this.matterReady,
      matterType: this.matterReady ? this.matterType : null,
      updated: new Date().toISOString(),
    };
    const key = JSON.stringify({ ...data, updated: 0, lastSeen: 0 });
    // Only write on change, or once a minute to refresh "last seen"
    if (key === this.lastRuntimeKey && Date.now() - (this.lastRuntimeWrite || 0) < 60000) return;
    try {
      fs.writeFileSync(this.runtimeFile, JSON.stringify(data, null, 2));
      this.lastRuntimeKey = key;
      this.lastRuntimeWrite = Date.now();
    } catch {
      /* non-fatal */
    }
  }

  markUnreachable() {
    const err = new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    const svc = this.outlet || this.scheduleSwitch;
    if (svc) svc.updateCharacteristic(Characteristic.On, err);
  }
}
