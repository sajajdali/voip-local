#!/usr/bin/python3
"""Authenticated HTTP trigger for connecting a mobile call to extension 1001."""

from __future__ import annotations

import hmac
import json
import re
import subprocess
import threading
import time
import urllib.parse
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from caller_lookup import load_env, normalize_phone


CONFIG_PATH = "/etc/asterisk-ai/outbound-api.env"
ASTERISK_CLI = "/usr/sbin/asterisk"
MOBILE_PATTERN = re.compile(r"09\d{9}")
TRUNK_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,64}")


class RateLimiter:
    def __init__(self, maximum: int, window_seconds: int):
        self.maximum = maximum
        self.window_seconds = window_seconds
        self.events: deque[float] = deque()
        self.recent_numbers: dict[str, float] = {}
        self.lock = threading.Lock()

    def allow(self, phone: str) -> bool:
        now = time.monotonic()
        with self.lock:
            while self.events and self.events[0] <= now - self.window_seconds:
                self.events.popleft()
            self.recent_numbers = {
                number: timestamp
                for number, timestamp in self.recent_numbers.items()
                if timestamp > now - 60
            }
            if len(self.events) >= self.maximum or phone in self.recent_numbers:
                return False
            self.events.append(now)
            self.recent_numbers[phone] = now
            return True


class CallServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], config: dict[str, str]):
        super().__init__(address, CallHandler)
        self.api_token = config["OUTBOUND_API_TOKEN"]
        self.trunk = config.get("OUTBOUND_API_TRUNK", "trunk-21009062")
        if not TRUNK_PATTERN.fullmatch(self.trunk):
            raise ValueError("invalid outbound trunk name")
        maximum = min(20, max(1, int(config.get("OUTBOUND_API_RATE_LIMIT", "5"))))
        self.limiter = RateLimiter(maximum, 60)


class CallHandler(BaseHTTPRequestHandler):
    server: CallServer

    def log_message(self, format: str, *args: object) -> None:
        # Do not log query strings, tokens, or phone numbers.
        return

    def send_json(self, status: int, payload: dict[str, object]) -> None:
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def authenticated(self) -> bool:
        expected = f"Bearer {self.server.api_token}"
        return hmac.compare_digest(self.headers.get("Authorization", ""), expected)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            self.send_json(200, {"status": "ok"})
            return
        if parsed.path != "/v1/call":
            self.send_json(404, {"error": "not_found"})
            return
        if not self.authenticated():
            self.send_json(401, {"error": "unauthorized"})
            return
        values = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        phone = normalize_phone(values.get("mobile", [""])[0])
        if not MOBILE_PATTERN.fullmatch(phone):
            self.send_json(400, {"error": "invalid_mobile"})
            return
        if not self.server.limiter.allow(phone):
            self.send_json(429, {"error": "rate_limited"})
            return
        command = (
            f"channel originate PJSIP/{phone}@{self.server.trunk} "
            "extension 1001@api-connect"
        )
        try:
            result = subprocess.run(
                [ASTERISK_CLI, "-rx", command],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            self.send_json(503, {"error": "asterisk_unavailable"})
            return
        # Asterisk 22 can queue a CLI originate successfully without printing the
        # older "successfully queued" confirmation.  The CLI exit status is the
        # reliable compatibility signal across supported Asterisk versions.
        if result.returncode != 0:
            self.send_json(503, {"error": "originate_failed"})
            return
        self.send_json(202, {"status": "accepted"})


def main() -> None:
    config = load_env(CONFIG_PATH)
    host = config.get("OUTBOUND_API_HOST", "192.168.100.41")
    port = int(config.get("OUTBOUND_API_PORT", "9020"))
    server = CallServer((host, port), config)
    server.serve_forever(poll_interval=0.5)


if __name__ == "__main__":
    main()
