/**
 * A pretend OpenEO charger for the tests (a JavaScript copy of the original tools/mock-openeo.py).
 * It answers the API the plugin uses, and acts like a plugged-in car that charges while
 * charge-now ("switch") is on.
 *
 * Test-only controls: charge(kWh), replug(), setFault(on), go offline with stop().
 * `settings` lists every /setsettings body received.
 */
import http from 'node:http'
import process from 'node:process'

export async function startFakeCharger({ serial = 'EO123456', port = 0 } = {}) {
  const db = {
    switch: { on: 'False', amps: '16', enabled: 'True' },
    scheduler: { enabled: 'True', schedule: '[]' },
    loadmanagement: { enabled: 'True', solar_enable: 'False' },
  }
  const session = { kwh: 4.21, ts: 1761300000 }
  const flags = { fault: false, plugged: true }
  const settings = []
  const b = v => String(v).toLowerCase() === 'true' || v === '1'

  const status = () => {
    const on = b(db.switch.on)
    const amps = Math.trunc(Number(db.switch.amps))
    const req = on && flags.plugged
      ? amps
      : 0
    let id = flags.plugged
      ? (req ? 12 : 10)
      : 5
    if (flags.fault) {
      id = 4
    }
    return {
      eo_serial_number: serial,
      app_version: 'v1.2.3',
      eo_charger_state_id: id,
      eo_charger_state: flags.fault
        ? 'mains-fault'
        : req
          ? 'charging'
          : flags.plugged ? 'car-connected' : 'idle',
      eo_session_cost: 1.23,
      charger_name: 'Garage',
      eo_amps_requested: req,
      eo_current_vehicle: req * 0.98,
      eo_power_delivered: Math.round(req * 0.98 * 235) / 1000,
      eo_live_voltage: 235.0,
      eo_session_kwh: Math.round(session.kwh * 1000) / 1000,
      eo_session_timestamp: session.ts,
      eo_overall_limit_current: 32,
    }
  }
  const config = () => ({
    switch: {
      enabled: true,
      on: b(db.switch.on),
      amps: Math.trunc(Number(db.switch.amps)),
      retain_state_on_startup: true,
    },
    scheduler: {
      enabled: b(db.scheduler.enabled),
      schedule: [],
    },
    loadmanagement: {
      enabled: true,
      solar_enable: b(db.loadmanagement.solar_enable),
    },
  })

  const server = http.createServer((req, res) => {
    const send = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    if (req.method === 'GET' && req.url === '/getstatus') {
      return send(status())
    }
    if (req.method === 'GET' && req.url === '/getconfig') {
      return send(config())
    }
    if (req.method === 'GET' && req.url === '/getsessiondata') {
      return send([
        {
          first_timestamp: 1761210000,
          last_timestamp: 1761230000,
          joules: 52_000_000,
          seconds_charged: 14400,
          cost: 2.6,
        },
        {
          first_timestamp: 1761390000,
          last_timestamp: 1761400000,
          joules: 15_120_000,
          seconds_charged: 2700,
          cost: 0.76,
        },
      ])
    }
    if (req.method === 'POST' && req.url === '/setsettings') {
      let body = ''
      req.on('data', (c) => {
        body += c
      })
      req.on('end', () => {
        settings.push(body)
        for (const [k, v] of new URLSearchParams(body)) {
          const [module, key] = k.split(':')
          db[module] = db[module] || {}
          db[module][key] = v
        }
        send({
          status: 'success',
          config: config(),
        })
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))

  return {
    host: `127.0.0.1:${server.address().port}`,
    port: server.address().port,
    db,
    settings,
    charge(kwh = 1.5) {
      session.kwh += kwh
    },
    replug() {
      session.kwh = 0.5
      session.ts += 1000
    },
    setFault(on) {
      flags.fault = on
    },
    setPlugged(on) {
      flags.plugged = on
    },
    stop: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

// Run on its own to try the plugin without a charger: node test/fake-openeo-charger.js 8080
if (import.meta.url === `file://${process.argv[1]}`) {
  startFakeCharger({ port: Number(process.argv[2]) || 8080 }).then((fake) => {
    process.stdout.write(`Pretend OpenEO charger on http://${fake.host}\n`)
  })
}
