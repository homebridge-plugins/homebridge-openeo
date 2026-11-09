# homebridge-openeo

Homebridge plugin for **EO Mini Pro 2 / EO Smart Home Hub** chargers running
[OpenEO](https://github.com/minceheid/openeo). Fully local — it talks to the
charger's own HTTP API on your LAN, no cloud.

## What you get in the Home app

| Accessory | HomeKit type | What it does |
|---|---|---|
| **EV Charger** | Outlet | **On** = "charge now" (OpenEO's manual switch). **Off** = hand back to your timers/solar. The *In Use* indicator lights when the car is actually drawing power. Power, voltage, current and session kWh show in the Eve app. |
| **Car Connected** | Occupancy sensor | Detected when a car is plugged in. Handy for automations ("when car arrives & it's after 11pm…"). |
| **Charging Schedule** | Switch | Enables/disables OpenEO's timer schedules. |
| **Charge Current** *(optional, off by default)* | Fan | Speed % = amps out of 32 A (50% = 16 A, minimum 6 A). |
| **Charger Problem** | Contact sensor | **Opens** if the charger reports a mains fault, or has been unreachable for longer than `offlineAlertMinutes` (default 5). Closes again when it recovers. Turn on notifications for it in the Home app to get an alert. |

## Finding the charger automatically

Leave **Charger address** blank (or set it to `auto`) and the plugin finds the charger itself:

1. It tries `openeo.local`.
2. It scans this machine's own subnet(s), and any **Extra subnets to search** you list
   (e.g. `192.168.20.0/24` for an IoT VLAN), asking each address for OpenEO's status page on port 80.

The address it finds is saved (`openeo-discovered.json` in Homebridge's storage folder). If the
charger disappears for more than 2 minutes, for example because it got a new IP, the plugin searches
again (at most every 5 minutes). Entering a fixed IP is still the most reliable option.

## Status page in the Homebridge UI

Open **Plugins → OpenEO EV Charger → ⋮ → Plugin Config** and the settings page shows, above the
normal settings form:

- the charger's live state (charging / car connected / idle / offline), with any problem highlighted
- power, current, voltage, this session's kWh, the plugin's lifetime kWh, charge-now / schedule / solar status
- the last 10 charging sessions from OpenEO (date, kWh, charging time, cost)
- a **Search** button that finds chargers on the network, with **Use this** to save the address


> How OpenEO combines things: it charges at the **highest** current any module asks for. So with the
> EV Charger outlet **on**, the car charges regardless of schedule. With it **off**, the schedule
> (if enabled) decides.

## Matter energy reporting (live watts in Apple Home)

With **Homebridge 2.2 or later**, the charger can also be published over **Matter** as an
outlet with *Electrical Power Measurement* and *Electrical Energy Measurement*. HomeKit (HAP)
accessories can't carry these readings to the Home app; Matter ones can.

What Apple Home does with them (iOS/tvOS 27 or later; Apple doesn't document this, so it may change):

- **Live watts on the tile.** Apple Home shows power only on accessories typed as an *outlet*, which
  is why the charger is published as one. If the tile's "Show As" is changed to something else in the
  Home app, the watts disappear.
- **Energy view.** Energy from bridged accessories (anything coming through Homebridge) counts toward
  the home's total, but the charger isn't listed as its own device there. That's Apple's rule for
  bridges, not something the plugin can change.

What changes when Matter is on:

- The **EV Charger** on/off tile comes from Matter (with power + energy). The HomeKit outlet is
  dropped so you don't get two tiles. Set `hapOutletWithMatter: true` if you want both.
- **Car Connected**, **Charging Schedule** and **Charge Current** stay on HomeKit.
- Energy is a lifetime total. OpenEO only reports kWh for the current session, so the plugin adds
  up each session and saves the total in Homebridge's storage folder
  (`openeo-energy-*.json`). It starts counting from zero the first time the plugin runs.

### Setup

1. Update Homebridge to 2.2+.
2. Run this plugin as a **child bridge** and give that child bridge a `matter` block. In the
   Homebridge UI that's the plugin's *Bridge Settings*; in `config.json` it looks like:

   ```json
   {
     "platform": "OpenEO",
     "name": "EV Charger",
     "host": "openeo.local",
     "_bridge": {
       "username": "0E:AB:CD:12:34:56",
       "port": 51830,
       "matter": { "port": 5541 }
     }
   }
   ```

3. Restart Homebridge. The log shows a Matter pairing QR code / setup code for that bridge.
4. In the Home app: **+ → Add Accessory**, scan the Matter code. Accept the "uncertified accessory"
   warning (expected, Homebridge's Matter bridge isn't CSA-certified).
5. Pair the bridge's normal HomeKit code too if you want the car sensor and schedule switch.

If Matter isn't enabled on the bridge, or registration fails, the plugin logs why and falls
back to the HomeKit outlet automatically.

## Experimental: Matter EV charger device type (Homebridge 2.5+)

Homebridge 2.5 added Matter's proper **EV charger** (EVSE) device type. Set **Matter device type**
to **EV charger (experimental)** (`"matterDeviceType": "evCharger"`) to publish the charger as one:

| Matter EV charger feature | Comes from / does |
|---|---|
| Charging state (not plugged in / plugged in / charging / fault) | OpenEO's charger state |
| Enable charging (with a maximum current) | Turns on OpenEO's *charge now* at that current (6–32 A). A current below 6 A is refused. |
| Enable charging *until* a time | Charges now, then turns charge-now off at that time |
| Disable | Turns charge-now off (back to schedule) |
| Charging mode: Manual / Timer schedule / Solar | Manual = schedule and solar off; Timer = schedule on; Solar = OpenEO solar charging on |
| Current limits, circuit capacity | Charge-now amps, OpenEO's overall current limit |
| Session ID, duration, energy | OpenEO's current charging session |
| Fault | OpenEO mains fault |
| Power, voltage, current, lifetime kWh | A meter part on the charger (same readings as the outlet) |

Also published as parts, because Matter requires them for an EV charger: a mains power source and an
energy-management part.

**Why experimental:** Homebridge itself warns that *"it is not yet known how Apple Home presents these
types"*. **Tested result (November 2026): the Home app shows the EV charger as "not supported".** So
use Outlet for Apple Home for now. The mode may still be useful with other Matter controllers, and is
ready for when Apple adds EV charger support. In this mode the plugin **keeps the HomeKit EV Charger
on/off outlet** as well, so you never lose control.

Switching between Outlet and EV charger removes one Matter accessory and publishes the other, so you'll
need to add the new one in the Home app (scan the bridge's Matter code again if the Home app asks).
On Homebridge older than 2.5 the setting falls back to the outlet and logs why.

## Install

On the machine running Homebridge (it needs internet access during install, to fetch the small
`@homebridge/plugin-ui-utils` helper used by the status page):

```bash
# copy homebridge-openeo-1.3.0.tgz to the Homebridge machine, then:
sudo npm install -g ./homebridge-openeo-1.3.0.tgz
```

If you use the **Homebridge UI** (hb-service) and the above doesn't show the plugin, install into
Homebridge's own node_modules instead:

```bash
cd /var/lib/homebridge          # or wherever your Homebridge storage path is
sudo -u homebridge npm install ./homebridge-openeo-1.3.0.tgz
```

Then restart Homebridge. The plugin appears in the UI's Plugins tab with a settings form.

## Configure

Minimal `config.json` platform entry:

```json
{
  "platform": "OpenEO",
  "name": "EV Charger",
  "host": "openeo.local"
}
```

All options:

| Option | Default | Notes |
|---|---|---|
| `host` | blank | Charger IP, e.g. `192.168.1.50`. Blank or `auto` = find it automatically. |
| `discoverySubnets` | blank | Extra subnets to search in auto mode, comma-separated (e.g. `192.168.20.0/24`). |
| `name` | `EV Charger` | |
| `matter` | `true` | Publish the charger over Matter with power/energy when this bridge has Matter enabled. |
| `matterDeviceType` | `outlet` | `outlet` (recommended) or `evCharger` (experimental, Homebridge 2.5+; Apple Home currently shows it as "not supported"). |
| `hapOutletWithMatter` | `false` | Keep the HomeKit outlet as well as the Matter one. Always kept in EV charger mode. |
| `pollInterval` | `10` | Seconds between status reads (3–300). |
| `defaultAmps` | `32` | Used when switching on if OpenEO has no manual current stored yet. |
| `exposeCarSensor` | `true` | |
| `exposeScheduleSwitch` | `true` | |
| `exposeCurrentControl` | `false` | Shown as a fan. |
| `exposeEnergy` | `true` | Eve-app power/energy readings. |
| `exposeFaultSensor` | `true` | The Charger Problem sensor. |
| `offlineAlertMinutes` | `5` | How long the charger must be unreachable before Charger Problem opens. |
| `timeout` | `5` | HTTP timeout in seconds. |

**Check it works first:** from the Homebridge machine run
`curl http://openeo.local/getstatus` — you should get JSON back. If that fails, fix name
resolution (use the IP) before debugging the plugin.

## Notes & caveats

- If the charger is unreachable, its tiles show **No Response** until it's back. The Charger
  Problem sensor keeps working so it can tell you.
- The Charge Current fan shares the on/off state with the main outlet. Be aware Siri's
  "turn off all the fans" would stop charging if you enable it.
- OpenEO's API has no authentication — anyone on your LAN can control the charger. Keep it
  on a trusted network.
- Uses OpenEO's `switch:on`, `switch:amps` and `scheduler:enabled` settings — the same ones the
  OpenEO home page uses, so changes show up in both places.

## Automation ideas

- *When Car Connected → detected, after 22:00:* turn on EV Charger.
- *When EV Charger In Use turns off* (charge complete): send a notification (via a Shortcuts automation).
- *When Charger Problem opens:* the Home app notifies you (enable notifications on the sensor).
- Use with an electricity-price HomeKit accessory to start charging when power is cheap.

## Trying it without a charger

`tools/mock-openeo.py` is a small fake OpenEO charger for testing. It answers the same API the plugin
uses (`/getstatus`, `/getconfig`, `/setsettings`, `/getsessiondata`), and behaves like a car that's
plugged in and charges when charge-now is switched on.

```bash
python3 tools/mock-openeo.py 8080
```

Then set the plugin's **Charger address** to `127.0.0.1:8080`. Extra test-only endpoints:

- `/_charge` adds 1.5 kWh to the current session
- `/_replug` starts a new session (simulates unplugging and plugging back in)
- `/_fault` toggles a mains fault
- `/_log` lists every settings change the plugin has sent

## Project layout

| File | What it is |
|---|---|
| `index.js` | The platform: HomeKit accessories, polling, Matter outlet, fault sensor, discovery wiring |
| `lib/evse.js` | Matter EV charger (EnergyEvse) mapping, Homebridge 2.5+ |
| `lib/discovery.js` | Finds OpenEO chargers on the network (`openeo.local`, then a subnet scan) |
| `homebridge-ui/` | The status page shown in the Homebridge UI (`server.js` backend, `public/index.html` page) |
| `config.schema.json` | Settings form for the Homebridge UI |
| `tools/mock-openeo.py` | Fake charger for testing (not included in the npm package) |

## How it was tested

There's no automated test suite in this folder yet. During development it was tested against the
fake charger above and:

- a hand-written stand-in for the Homebridge/HAP API (HomeKit accessories, discovery, fault sensor,
  Matter outlet updates)
- the **real Homebridge 2.5.0 Matter server and matter.js 0.18**, built from source (Matter outlet and
  EV charger registration, Matter commands, state updates, restarts, switching device type). These
  ran with matter.js's IPv6 network discovery stubbed out because the test machine had no IPv6, so
  pairing over the network wasn't part of those runs.
- the Homebridge UI page's backend run with the real `@homebridge/plugin-ui-utils`, and the page
  rendered in a browser.

On real hardware, it has been used with a Mac mini running Homebridge. The Matter EV charger mode
showed as "not supported" in the Home app.

## Changelog

- **1.3.0**: optional Matter EV charger device type (Homebridge 2.5+, experimental).
- **1.2.0**: Charger Problem sensor, auto-discovery, Homebridge UI status page.
- **1.1.0**: Matter outlet with power and energy measurement; lifetime kWh counter.
- **1.0.0**: HomeKit outlet, Car Connected sensor, Charging Schedule switch, optional current control.

## License

MIT. See `LICENSE`.
