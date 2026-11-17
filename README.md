# ORBI

ORBI’s first milestone is a browser dashboard that reports Raspberry Pi and ESP32
connectivity independently and verifies the full command path with a ping.

## Run locally

Use Node.js 20.9 or newer. Copy `.env.example` to `.env.local` and set different
values for `ORBI_OWNER_PASSWORD` and `ORBI_DEVICE_TOKEN`. Use strong random secrets.

```sh
npm install
npm run dev
```

Open http://localhost:3000 and sign in with the owner password. In a second terminal:

```sh
node --env-file=.env.local scripts/simulate.mjs
```

Both devices should appear online. Select **Ping ESP32** and check that the command
changes from pending to succeeded. Restart the simulator with `--esp32-offline`
to check that only the Pi appears online. Stop the simulator and allow 30 seconds
for the Pi to appear offline. Local development without Supabase stores state in
memory and clears it when the server restarts.

## Deploy

Apply `schema.sql` in Supabase. Connect the repository to Vercel and set
`SUPABASE_URL`, `SUPABASE_SECRET_KEY` (a server-side Supabase secret key),
`ORBI_OWNER_PASSWORD`, and `ORBI_DEVICE_TOKEN` in its environment settings.
The frontend keeps the owner credential in memory for the signed-in tab.
Set `ORBI_URL` to the deployment URL to test it with the simulator over HTTPS.

## Connect the hardware

1. Open `device/esp32/orbi_serial/orbi_serial.ino` in Arduino IDE with the ESP32
   board package installed. Select the DevKit's board and USB port, then upload.
2. Connect the ESP32 to the Pi with a USB data cable. On the Pi, use
   `ls -l /dev/serial/by-id/` to identify its stable device path.
   If that directory has no entry, check `ls /dev/ttyUSB* /dev/ttyACM*` to see
   whether the Pi detected a serial device. Use the stable path when available.
   Run the following from the repository root on the Pi, replacing the path
   with the detected device. Stop the ORBI agent first if it is already running.

   ```sh
   sudo python3 device/pi/agent.py --check-serial /dev/serial/by-id/your-esp32-adapter
   ```

   Expect `ESP32 replied: ORBI READY` and `ESP32 returned the matching PONG`.
   This verifies the Pi-to-ESP32 link without internet access or cloud credentials.
3. Copy the agent files onto the Pi and run the following from the repository
   root. The supplied service uses the existing Pi login `alliance`; edit
   `User=` if the target Pi uses a different account.

```sh
sudo install -D -m 644 device/pi/agent.py /opt/orbi/agent.py
sudo install -m 644 device/pi/orbi-agent.service /etc/systemd/system/orbi-agent.service
sudo touch /etc/orbi-agent.env
sudo chmod 600 /etc/orbi-agent.env
sudoedit /etc/orbi-agent.env
```

Set these values in the environment file, using the matching token from Vercel:

```dotenv
ORBI_URL=https://your-orbi-deployment.example
ORBI_DEVICE_TOKEN=your-device-token
ORBI_SERIAL_PORT=/dev/serial/by-id/your-esp32-adapter
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now orbi-agent
sudo journalctl -u orbi-agent -n 30
```

Verify both devices online, send **Ping ESP32**, unplug and reconnect the ESP32,
then reboot the Pi and check that both devices return online automatically.
Also unplug only the ESP32 and confirm the Pi remains online. After a Pi reboot,
verify the service is running with `systemctl is-active orbi-agent` and that both
devices return online without starting the agent manually.

## Device interface

The Pi uses its bearer token on these routes:

- `POST /api/device/heartbeat` with `{"esp32Connected":true}` after an ESP32
  responds to `HELLO` over serial. The Pi posts `false` if the ESP32 is absent.
- `GET /api/device/commands` to poll for pending pings.
- `POST /api/device/commands/<id>/result` with `{"ok":true}` after an ESP32 reply
  or `{"ok":false}` after a serial failure. The API expires pings after 60 seconds.
