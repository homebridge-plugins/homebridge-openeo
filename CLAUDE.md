# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Homebridge dynamic platform for an EO Mini Pro 2 or EO Smart Home Hub EV charger running OpenEO (https://github.com/minceheid/openeo), open-source firmware that replaces EO's discontinued cloud app. It talks only to the charger's local HTTP API (no authentication, no cloud): a charge-now outlet, Car Connected sensor, Charging Schedule switch, optional Charge Current fan, Charger Problem sensor, and live watts/kWh over Matter. Written in JavaScript (ES modules), no build step. Created by @Wazza151.

## Commands

- **Lint**: `npm run lint` (eslint with zero warnings allowed)
- **Lint + fix**: `npm run lint:fix`
- **Test**: `npm test` (vitest, a few seconds)

CI runs lint, then the tests on Node 22, 24 and 26.

## Code Style

Uses `@antfu/eslint-config` with these key rules:
- Single quotes, no semicolons, 1tbs brace style
- Sorted imports/exports via `perfectionist`
- Node globals imported from `node:` modules (`Buffer`, `process`)
- Zero warnings tolerance (`--max-warnings=0`)

## Architecture

- `lib/index.js` registers `OpenEOPlatform` (`lib/platform.js`) under the alias "OpenEO". One charger per plugin (the schema is `singular`).
- `lib/platform.js`: works out the address (or auto-discovery), HAP vs Matter, removes stale cached accessories, and starts an `OpenEOCharger`. Stops it on Homebridge shutdown.
- `lib/charger.js`: the HAP services, polling (`/getstatus` + `/getconfig`), writes (`/setsettings`, form-encoded `module:key=value`), the fault sensor, rediscovery, and the Matter outlet / EV charger. It registers over Matter on every start (Homebridge restores cached Matter accessories with empty handlers) and retries while the bridge's Matter server is still starting.
- `lib/evse.js`: the experimental Matter EV charger (EnergyEvse, Homebridge 2.5+): OpenEO state to Matter attributes, and the composed accessory with its power source, meter and energy management parts.
- `lib/client.js`: the small HTTP client. `lib/discovery.js`: `openeo.local`, then a scan of the local subnets (and any extra ones) for `/getstatus`.
- `lib/energy-counter.js`: OpenEO only reports the current session's kWh, so this adds up session deltas into a lifetime total for Matter.
- `lib/homebridge-ui/`: the status page in the Homebridge UI (`server.js` uses `@homebridge/plugin-ui-utils`).

OpenEO charges at the HIGHEST current any of its modules asks for: with charge-now ("switch") on the car charges whatever the schedule says; off hands back to the schedule or solar.

Files are kept in Homebridge's storage folder: `openeo-energy-<id>.json` (lifetime kWh), `openeo-discovered.json` (the address found), `openeo-runtime.json` (read by the status page).

## Tests

- `lib/*.test.js`: unit tests next to the code
- `test/e2e.test.js` and `test/matter.test.js`: the plugin inside Homebridge's own API and HAP (loaded by file path from the `homebridge` dev dependency, in `test/harness.js`) against a pretend charger (`test/fake-openeo-charger.js`, which also runs on its own: `node test/fake-openeo-charger.js 8080`). `test/matter-stand-in.js` is a stand-in Matter API that keeps Homebridge's rules.
- `test/config-schema.test.js`: keeps `config.schema.json` valid for the Homebridge UI and Homebridge verification
