/**
 * Backend for the plugin's page in the Homebridge UI.
 * Runs as a child process of homebridge-config-ui-x.
 */

import fs from 'node:fs'
import path from 'node:path'

import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils'

import { discover, probe } from '../discovery.js'

function toBaseUrl(host) {
  return (/^https?:\/\//i.test(host)
    ? host
    : `http://${host}`).replace(/\/+$/, '')
}

async function getJson(url, timeoutMs = 4000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

class OpenEOUiServer extends HomebridgePluginUiServer {
  constructor() {
    super()
    this.storage = this.homebridgeStoragePath || ''
    this.onRequest('/status', body => this.status(body))
    this.onRequest('/discover', body => this.discover(body))
    this.onRequest('/probe', body => this.probeHost(body))
    this.ready()
  }

  /** Which address to talk to: what's in the config form, else what the plugin discovered. */
  resolveHost(configHost) {
    const h = String(configHost || '').trim()
    if (h && h.toLowerCase() !== 'auto') {
      return { host: h, source: 'config' }
    }
    const cached = readJson(path.join(this.storage, 'openeo-discovered.json'))
    if (cached && cached.host) {
      return { host: cached.host, source: 'discovered' }
    }
    return { host: null, source: 'none' }
  }

  async status(body) {
    const { host, source } = this.resolveHost(body.host)
    const runtime = readJson(path.join(this.storage, 'openeo-runtime.json'))
    const result = {
      host,
      source,
      runtime,
      reachable: false,
    }
    if (!host) {
      return result
    }

    const base = toBaseUrl(host)
    try {
      const [status, config] = await Promise.all([
        getJson(`${base}/getstatus`),
        getJson(`${base}/getconfig`),
      ])
      result.reachable = true
      result.status = status
      result.config = {
        switch: config.switch || {},
        scheduler: config.scheduler || {},
        loadmanagement: config.loadmanagement || {},
      }
    } catch (err) {
      const cause = err.cause || {}
      const code = cause.code || (Array.isArray(cause.errors) && cause.errors[0] && cause.errors[0].code)
      const friendly = {
        ECONNREFUSED: 'connection refused - is OpenEO running on port 80?',
        EHOSTUNREACH: 'host unreachable - check the IP / VLAN firewall',
        ENETUNREACH: 'network unreachable - check the IP / VLAN routing',
        ENOTFOUND: 'name not found - use the IP address instead',
        ETIMEDOUT: 'timed out',
      }
      result.error = err.name === 'AbortError'
        ? 'timed out'
        : friendly[code] || code || cause.message || err.message
      return result
    }
    try {
      const sessions = await getJson(`${base}/getsessiondata`, 6000)
      result.sessions = Array.isArray(sessions)
        ? sessions.sort((a, b) => b.first_timestamp - a.first_timestamp).slice(0, 10)
        : []
    } catch {
      result.sessions = []
    }
    return result
  }

  async discover(body) {
    const subnets = String(body.subnets || '')
      .split(/[\s,]+/)
      .filter(Boolean)
    const found = await discover({ subnets })
    return { found }
  }

  async probeHost(body) {
    const host = String(body.host || '').trim()
    if (!host) {
      return { ok: false }
    }
    const hit = await probe(host.replace(/^https?:\/\//i, ''), 3000)
    return { ok: !!hit, charger: hit }
  }
}

// eslint-disable-next-line no-new
new OpenEOUiServer()
