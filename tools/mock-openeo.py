#!/usr/bin/env python3
"""
Fake OpenEO charger for testing homebridge-openeo without real hardware.

Usage:  python3 tools/mock-openeo.py [port]      (default port 8080)
Then set the plugin's "Charger address" to 127.0.0.1:<port>.

Implements the OpenEO endpoints the plugin uses: /getstatus, /getconfig, /setsettings, /getsessiondata.
Acts like a car that is plugged in and charges whenever charge-now ("switch") is on.

Test-only endpoints:
  /_charge   add 1.5 kWh to the current session
  /_replug   start a new session (unplug + plug back in)
  /_fault    toggle a mains fault
  /_log      list every /setsettings body received
"""
import json, sys, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

db = {"switch": {"on": "False", "amps": "16", "enabled": "True"},
      "scheduler": {"enabled": "True", "schedule": "[]"}}
log = []
sess = {"kwh": 4.21, "ts": 1761300000}
flags = {"fault": False}

def b(v): return str(v).lower() == "true" or v == "1"

def status():
    on = b(db["switch"]["on"]); amps = int(float(db["switch"]["amps"]))
    req = amps if on else 0
    return {"eo_serial_number": "EO123456", "app_version": "v1.2.3",
            "eo_charger_state_id": 4 if flags["fault"] else (12 if req else 10),
            "eo_charger_state": "mains-fault" if flags["fault"] else ("charging" if req else "car-connected"), "eo_session_cost": 1.23, "charger_name": "Garage",
            "eo_amps_requested": req, "eo_current_vehicle": req * 0.98,
            "eo_power_delivered": round(req * 0.98 * 235 / 1000, 3),
            "eo_live_voltage": 235.0, "eo_session_kwh": round(sess["kwh"], 3), "eo_session_timestamp": sess["ts"],
            "eo_overall_limit_current": 32}

def config():
    return {"switch": {"enabled": True, "on": b(db["switch"]["on"]), "amps": int(float(db["switch"]["amps"])), "retain_state_on_startup": True},
            "scheduler": {"enabled": b(db["scheduler"]["enabled"]), "schedule": []}, "loadmanagement": {"enabled": True, "solar_enable": False}}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, obj):
        d = json.dumps(obj).encode(); self.send_response(200)
        self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(d)
    def do_GET(self):
        if self.path == "/getstatus": return self.send(status())
        if self.path == "/getconfig": return self.send(config())
        if self.path == "/_log": return self.send(log)
        if self.path == "/_fault": flags["fault"] = not flags["fault"]; return self.send(flags)
        if self.path == "/getsessiondata": return self.send([
            {"first_timestamp": 1761210000, "last_timestamp": 1761230000, "day_timestamp": 0, "joules": 52_000_000, "seconds_charged": 14400, "cost": 2.6, "cost_by_tariff": ""},
            {"first_timestamp": 1761390000, "last_timestamp": 1761400000, "day_timestamp": 0, "joules": 15_120_000, "seconds_charged": 2700, "cost": 0.76, "cost_by_tariff": ""}])
        if self.path == "/_charge": sess["kwh"] += 1.5; return self.send(sess)
        if self.path == "/_replug": sess["kwh"] = 0.5; sess["ts"] += 1000; return self.send(sess)
        self.send_error(404)
    def do_POST(self):
        if self.path != "/setsettings": return self.send_error(404)
        body = self.rfile.read(int(self.headers["Content-Length"])).decode()
        log.append(body)
        for k, v in urllib.parse.parse_qsl(body):
            m, key = k.split(":", 1); db.setdefault(m, {})[key] = v
        self.send({"status": "success", "config": config()})

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
print(f"Fake OpenEO charger on http://127.0.0.1:{port}")
ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
