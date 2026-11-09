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

import { PLATFORM_NAME, PLUGIN_NAME } from './constants.js'
import { OpenEOPlatform } from './platform.js'

export default (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, OpenEOPlatform)
}
