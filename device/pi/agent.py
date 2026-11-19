"""Report ORBI connectivity and relay test pings to an ESP32 over USB serial."""

import argparse
import json
import logging
import os
import select
import termios
import time
import tty
from urllib.request import Request, urlopen
from uuid import uuid4


class Esp32:
    def __init__(self, path):
        self.path = path
        self.fd = None
        self.last_error = None

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def exchange(self, message, expected):
        self.last_error = None
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
                    self.last_error = "USB serial port disconnected"
                    return False
                data.extend(chunk)
                while b"\n" in data:
                    line, _, data = data.partition(b"\n")
                    if line.rstrip(b"\r") == expected.encode("ascii"):
                        return True
                if len(data) > 256:
                    data.clear()
            self.last_error = f"Timed out waiting for {expected}"
        except (OSError, termios.error) as error:
            self.close()
            self.last_error = str(error)
        return False


class Cloud:
    def __init__(self, url, token):
        self.base = url.rstrip("/") + "/api/device/"
        self.token = token

    def call(self, path, body=None, jpeg=None):
        headers = {
            "Authorization": "Bearer " + self.token,
            "Content-Type": "image/jpeg" if jpeg is not None else "application/json",
        }
        bypass = os.environ.get("ORBI_VERCEL_BYPASS_SECRET")
        if bypass:
            headers["x-vercel-protection-bypass"] = bypass
        request = Request(
            self.base + path,
            data=jpeg if jpeg is not None else (None if body is None else json.dumps(body).encode("utf-8")),
            headers=headers,
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
    return connected


def check_serial(path):
    esp32 = Esp32(path)
    ping_id = str(uuid4())
    try:
        # Some boards reset when their serial port opens.
        for _ in range(3):
            if esp32.exchange("HELLO", "ORBI READY"):
                print("ESP32 replied: ORBI READY")
                if esp32.exchange(f"PING {ping_id}", f"PONG {ping_id}"):
                    print("ESP32 returned the matching PONG")
                    return 0
                break
            time.sleep(0.5)
        logging.error("%s: %s", path, esp32.last_error)
        return 1
    finally:
        esp32.close()


class Camera:
    def __init__(self, path):
        self.path = path
        self.last_upload = 0

    def upload(self, cloud):
        if time.monotonic() - self.last_upload < 10:
            return
        self.last_upload = time.monotonic()
        import cv2
        camera = cv2.VideoCapture(self.path, cv2.CAP_V4L2)
        try:
            camera.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
            camera.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            success, frame = camera.read()
            if not success:
                cloud.call("camera/offline", {})
                return
            success, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 65])
            if not success or len(encoded) > 160_000:
                cloud.call("camera/offline", {})
                return
            cloud.call("camera", jpeg=encoded.tobytes())
        finally:
            camera.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-serial", metavar="PORT", help="Test the ESP32 over USB and exit")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if args.check_serial:
        return check_serial(args.check_serial)
    cloud = Cloud(os.environ["ORBI_URL"], os.environ["ORBI_DEVICE_TOKEN"])
    esp32 = Esp32(os.environ["ORBI_SERIAL_PORT"])
    camera = Camera(os.environ.get("ORBI_CAMERA_DEVICE", "/dev/video0")) if (
        os.environ.get("ORBI_CAMERA_ENABLED") == "1"
    ) else None
    results = {}
    delay = 3
    previous_connection = None
    try:
        while True:
            try:
                connected = sync(cloud, esp32, results)
                if connected != previous_connection:
                    if connected:
                        logging.info("ESP32 connected on %s", esp32.path)
                    else:
                        logging.warning("ESP32 offline on %s: %s", esp32.path, esp32.last_error)
                previous_connection = connected
                delay = 3
                if camera:
                    try:
                        camera.upload(cloud)
                    except Exception as error:
                        logging.warning("Camera upload failed (%s)", type(error).__name__)
            except (OSError, ValueError) as error:
                logging.warning("Cloud request failed (%s). Retrying in %ss.", error, delay)
                time.sleep(delay)
                delay = min(delay * 2, 12)
                continue
            time.sleep(delay)
    finally:
        esp32.close()


if __name__ == "__main__":
    raise SystemExit(main())
