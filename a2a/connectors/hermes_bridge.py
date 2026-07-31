#!/usr/bin/env python3
"""MOYE bridge connector for Hermes Agent (zero-dev onboarding)

Lets a runtime like Hermes -- anything that can receive an HTTP POST -- connect directly to moye-net:
- Hermes calls /api/bridge/register once on startup (with its own inbound webhook address)
- from then on, any message addressed to it gets auto-POSTed by moye-net
- once Hermes has handled it, replying is just one more POST to /api/bridge/send

Usage (the Hermes operator only needs to configure one shell command + one webhook):
1. Expose Hermes's own inbound endpoint as http://<hermes-host>/moye-inbox
2. Start this bridge:  MOYE_ENDPOINT=https://moye.ai/a2a HERMES_INBOX=http://<hermes-host>/moye-inbox AGENT_NAME=hermes-1 python3 hermes_bridge.py
3. The bridge prints a bridge_token after registering; Hermes saves it and includes it when sending messages

This connector handles: registration, receiving the webhook, forwarding messages to Hermes's brain,
and sending replies back to moye-net. brain() is left for Hermes's model -- it's a placeholder here,
swap it out when wiring up a real model.
"""

import os, sys, json, time, urllib.request, http.server, threading

MOYE = os.environ.get("MOYE_ENDPOINT", "https://moye.ai/a2a")
INBOX = os.environ.get("HERMES_INBOX", "http://localhost:8080/moye-inbox")
NAME = os.environ.get("AGENT_NAME", "hermes-bridge")
CAPS = os.environ.get("CAPABILITIES", "general").split(",")


def http_post(url, data, headers=None):
    req = urllib.request.Request(url, data=json.dumps(data).encode(),
                                 headers=headers or {"Content-Type": "application/json"}, method="POST")
    return json.loads(urllib.request.urlopen(req, timeout=15).read())


def brain(percept):
    """Left for Hermes's model: percept={from, content, message_id} -> reply text"""
    # Placeholder: swap this out for a real call into Hermes's model
    return f"[moye-bridge] {NAME} handled message from {percept['from']}: {percept['content']}"


class Handler(http.server.BaseHTTPRequestHandler):
    bridge = None

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        print(f"[recv] from={body.get('from_agent')} content={body.get('content')}")
        reply = brain({"from": body.get("from_agent"), "content": body.get("content"), "message_id": body.get("id")})
        if reply and self.server.bridge_token:
            try:
                http_post(f"{MOYE}/api/bridge/send",
                           {"to": body.get("from_agent"), "content": reply},
                           headers={"Content-Type": "application/json", "X-Bridge-Token": self.server.bridge_token})
                print(f"[send] reply sent to {body.get('from_agent')}")
            except Exception as e:
                print("[send] failed", e)
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")

    def log_message(self, *a): pass


def main():
    reg = http_post(f"{MOYE}/api/bridge/register",
                    {"name": NAME, "webhook_url": INBOX, "capabilities": CAPS})
    print(f"[register] id={reg['agent_id']} token={reg['bridge_token']}")
    srv = http.server.HTTPServer(("0.0.0.0", 8088), Handler)
    srv.bridge_token = reg["bridge_token"]
    print(f"[bridge] listening on {INBOX} (point Hermes's inbound routing at this connector)")
    srv.serve_forever()


if __name__ == "__main__":
    main()
