import path from 'node:path'

import { buildEveCharacteristics } from './characteristics.js'
import { OpenEOCharger } from './charger.js'
import { PLATFORM_NAME, PLUGIN_NAME } from './constants.js'
import * as evse from './evse.js'
import { toBaseUrl } from './utils.js'

let hap

/* ------------------------------------------------------------------------ */
/* Platform                                                                 */
/* ------------------------------------------------------------------------ */
export class OpenEOPlatform {
  constructor(log, config, api) {
    this.log = log
    this.config = config || {}
    this.api = api
    this.cachedAccessories = []
    this.cachedMatterAccessories = []

    hap = api.hap
    this.eveChars = buildEveCharacteristics(hap)

    api.on('didFinishLaunching', () => {
      this.setup().catch(err => this.log.error(`Setup failed: ${err.stack || err.message}`))
    })
  }

  configureAccessory(accessory) {
    this.cachedAccessories.push(accessory)
  }

  configureMatterAccessory(accessory) {
    this.cachedMatterAccessories.push(accessory)
  }

  matterAvailable() {
    return typeof this.api.isMatterEnabled === 'function' && this.api.isMatterEnabled() && !!this.api.matter
  }

  async setup() {
    const host = String(this.config.host || '').trim()
    const autoDiscover = !host || host.toLowerCase() === 'auto'
    const baseUrl = autoDiscover
      ? null
      : toBaseUrl(host)
    // Auto mode keys on "auto" so the accessory survives the charger's IP changing
    const key = autoDiscover ? 'auto' : baseUrl
    const name = this.config.name || 'EV Charger'
    const uuid = hap.uuid.generate(`openeo:${key}`)

    const wantMatter = this.config.matter !== false
    const useMatter = wantMatter && this.matterAvailable()

    if (wantMatter && !useMatter) {
      this.log.info(
        'Matter is not enabled on this bridge - using HomeKit (HAP) only. '
        + 'Add a "matter" block to this bridge to get Apple Home Energy reporting (Homebridge 2.2+).',
      )
    }

    // Which Matter device type to publish: the proven outlet, or the experimental EV charger (Homebridge 2.5+)
    let matterType = this.config.matterDeviceType === 'evCharger'
      ? 'evCharger'
      : 'outlet'
    if (useMatter && matterType === 'evCharger' && !evse.evseSupported(this.api.matter)) {
      this.log.warn('EV charger device type needs Homebridge 2.5 or later - publishing as a Matter outlet instead.')
      matterType = 'outlet'
    }
    // A different UUID per type, so switching type re-registers cleanly
    const matterUuid = hap.uuid.generate(
      matterType === 'evCharger'
        ? `openeo-matter-evse:${key}`
        : `openeo-matter:${key}`,
    )

    // Clean up Matter accessories we no longer want
    if (this.api.matter && this.cachedMatterAccessories.length) {
      const staleMatter = this.cachedMatterAccessories.filter(a => !useMatter || a.UUID !== matterUuid)
      if (staleMatter.length) {
        await this.api.matter
          .unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleMatter)
          .catch(e => this.log.warn(`Could not remove old Matter accessory: ${e.message}`))
      }
    }

    // HAP accessory
    let accessory = this.cachedAccessories.find(a => a.UUID === uuid)
    const isNew = !accessory
    if (isNew) {
      accessory = new this.api.platformAccessory(name, uuid, hap.Categories.OUTLET)
    }
    const stale = this.cachedAccessories.filter(a => a.UUID !== uuid)
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale)
    }

    const storage = this.api.user.storagePath()
    this.charger = new OpenEOCharger(this, {
      accessory,
      baseUrl,
      name,
      matterUuid,
      useMatter,
      matterType,
      autoDiscover,
      energyFile: path.join(storage, `openeo-energy-${uuid.slice(0, 8)}.json`),
      discoveryFile: path.join(storage, 'openeo-discovered.json'),
      runtimeFile: path.join(storage, 'openeo-runtime.json'),
    })

    if (isNew) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
    } else {
      this.api.updatePlatformAccessories([accessory])
    }

    if (useMatter) {
      await this.charger.registerMatter()
    }
  }
}
