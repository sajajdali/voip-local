#!/usr/bin/python3
"""Short AudioSocket smoke call; verifies live greeting audio without retaining it."""

import socket
import time
import uuid

import bridge


def main() -> None:
    received = 0
    deadline = time.monotonic() + 20
    with socket.create_connection(("127.0.0.1", 9019), timeout=5) as sock:
        sock.settimeout(2)
        sock.sendall(bridge.pack_frame(bridge.UUID_KIND, uuid.uuid4().bytes))
        while time.monotonic() < deadline and received < 8000:
            frame = bridge.read_frame(sock)
            if frame is None or frame[0] == bridge.HANGUP_KIND:
                break
            if frame[0] == bridge.AUDIO_KIND:
                received += len(frame[1])
        sock.sendall(bridge.pack_frame(bridge.HANGUP_KIND))
    if received < 3200:
        raise RuntimeError(f"insufficient greeting audio: {received} bytes")
    print(f"LIVE_GREETING_OK audio_bytes={received}")


if __name__ == "__main__":
    main()

