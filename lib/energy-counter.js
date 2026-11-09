import fs from 'node:fs'

/* ------------------------------------------------------------------------ */
/* Lifetime energy counter                                                  */
/* OpenEO only reports kWh for the current session (reset when the car is   */
/* unplugged). Matter wants a cumulative, never-decreasing meter, so we      */
/* accumulate session deltas and persist the total.                          */
/* ------------------------------------------------------------------------ */
export class EnergyCounter {
  constructor(file, log) {
    this.file = file
    this.log = log
    this.data = { totalWh: 0, lastSessionKWh: null, lastSessionTs: null }
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (Number.isFinite(saved.totalWh)) {
        this.data = {
          ...this.data,
          ...saved,
        }
      }
    } catch {
      /* first run */
    }
    this.dirty = false
  }

  get totalWh() {
    return this.data.totalWh
  }

  /** Feed the latest session reading; returns true if the total changed. */
  update(sessionKWh, sessionTs) {
    const d = this.data
    let delta = 0
    const newSession
      = d.lastSessionKWh === null
        || (sessionTs && d.lastSessionTs && sessionTs !== d.lastSessionTs)
        || sessionKWh < d.lastSessionKWh - 0.001

    if (d.lastSessionKWh === null) {
      delta = 0 // first ever reading: don't count energy from before we were watching
    } else if (newSession) {
      delta = sessionKWh // new session started since last poll
    } else {
      delta = sessionKWh - d.lastSessionKWh
    }

    d.lastSessionKWh = sessionKWh
    d.lastSessionTs = sessionTs || d.lastSessionTs

    if (delta > 0 && delta < 200) {
      d.totalWh += delta * 1000
      this.dirty = true
      return true
    }
    if (newSession) {
      this.dirty = true
    }
    return false
  }

  save() {
    if (!this.dirty) {
      return
    }
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data))
      this.dirty = false
    } catch (err) {
      this.log.warn(`Could not save energy total: ${err.message}`)
    }
  }
}
