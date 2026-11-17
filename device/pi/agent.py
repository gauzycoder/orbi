"""Report ORBI connectivity and relay test pings to an ESP32 over USB serial."""

import json
import logging
import os
import select
import termios
import time
import tty
from urllib.request import Request, urlopen


class Esp32:
    def __init__(self, path):
        self.path = path
        self.fd = None

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def exchange(self, message, expected):
        try:
            if self.fd is None:
                self.fd = os.open(self.path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
                tty.setraw(self.fd)
                config = termios.tcgetattr(self.fd)
                config[4] = config[5] = termios.B115200
                termios.tcsetattr(self.fd, termios.TCSANOW, config)
                termios.tcflush(self.fd, termios.TCIOFLUSH)

            os.write(self.fd, (message + "\n").encode("ascii"))
            deadline = time.monotonic() + 0.75
            data = bytearray()
            while (remaining := deadline - time.monotonic()) > 0:
                ready, _, _ = select.select([self.fd], [], [], remaining)
                if not ready:
                    break
                chunk = os.read(self.fd, 256)
                if not chunk:
                    self.close()
                    return False
                data.extend(chunk)
                while b"\n" in data:
                    line, _, data = data.partition(b"\n")
                    if line.rstrip(b"\r") == expected.encode("ascii"):
                        return True
                if len(data) > 256:
                    data.clear()
        except (OSError, termios.error):
            self.close()
        return False


class Cloud:
    def __init__(self, url, token):
        self.base = url.rstrip("/") + "/api/device/"
        self.token = token

    def call(self, path, body=None):
        request = Request(
            self.base + path,
            data=None if body is None else json.dumps(body).encode("utf-8"),
            headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"},
        )
        with urlopen(request, timeout=4) as response:
            return json.load(response)


def sync(cloud, esp32, results):
    connected = esp32.exchange("HELLO", "ORBI READY")
    cloud.call("heartbeat", {"esp32Connected": connected})
    commands = cloud.call("commands")["commands"]
    active = {command["id"] for command in commands}
    for command_id in results.keys() - active:
        del results[command_id]
    for command in commands:
        command_id = command["id"]
        if time.time() * 1000 >= command["expiresAt"]:
            continue
        if command_id not in results:
            if not connected:
                continue
            results[command_id] = command["type"] == "ping" and esp32.exchange(
                "PING " + command_id, "PONG " + command_id
            )
        cloud.call("commands/" + command_id + "/result", {"ok": results[command_id]})


def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    cloud = Cloud(os.environ["ORBI_URL"], os.environ["ORBI_DEVICE_TOKEN"])
    esp32 = Esp32(os.environ["ORBI_SERIAL_PORT"])
    results = {}
    delay = 3
    try:
        while True:
            try:
                sync(cloud, esp32, results)
                delay = 3
            except (OSError, ValueError) as error:
                logging.warning("Cloud request failed (%s). Retrying in %ss.", error, delay)
                time.sleep(delay)
                delay = min(delay * 2, 12)
                continue
            time.sleep(delay)
    finally:
        esp32.close()


if __name__ == "__main__":
    main()
