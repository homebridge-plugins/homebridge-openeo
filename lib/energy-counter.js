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

  /**
   * Feed the latest session reading; returns true if the total changed. `sessionTs` is the
   * session's start time, or 0 while no car is connected (OpenEO resets it every few seconds then).
   */
  update(sessionKWh, sessionTs) {
    const d = this.data
    if (d.lastSessionKWh === null) {
      // first ever reading: don't count energy from before we were watching
      d.lastSessionKWh = sessionKWh
      d.lastSessionTs = sessionTs || null
      this.dirty = true
      return false
    }

    let delta
    if (sessionTs && d.lastSessionTs && sessionTs !== d.lastSessionTs) {
      delta = sessionKWh // a new session started since the last reading
    } else if (sessionKWh < d.lastSessionKWh - 0.001) {
      if (sessionKWh >= d.lastSessionKWh / 2) {
        // a little lower: an older reading that arrived late, so skip it
        return false
      }
      delta = sessionKWh // OpenEO started the count again (car unplugged, or a new day)
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
