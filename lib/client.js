/* ------------------------------------------------------------------------ */
/* Small HTTP client for the OpenEO API                                     */
/* ------------------------------------------------------------------------ */
export class OpenEOClient {
  constructor(baseUrl, timeoutMs) {
    this.setBaseUrl(baseUrl)
    this.timeoutMs = timeoutMs
  }

  setBaseUrl(baseUrl) {
    this.baseUrl = baseUrl
      ? baseUrl.replace(/\/+$/, '')
      : null
  }

  async request(urlPath, options = {}) {
    if (!this.baseUrl) {
      throw new Error('Charger address not known yet (auto-discovery has not found it)')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(this.baseUrl + urlPath, { ...options, signal: controller.signal })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${urlPath}`)
      }
      return await res.json()
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(`Timed out after ${this.timeoutMs}ms calling ${urlPath}`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  getStatus() {
    return this.request('/getstatus')
  }

  getConfig() {
    return this.request('/getconfig')
  }

  setSettings(settings) {
    const body = new URLSearchParams()
    for (const [k, v] of Object.entries(settings)) {
      body.append(k, String(v))
    }
    return this.request('/setsettings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
  }
}
