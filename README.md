# ORBI

ORBI’s first milestone is a browser dashboard that reports Raspberry Pi and ESP32
connectivity independently and verifies the full command path with a ping.

## Run locally

Use Node.js 20.9 or newer. Create `.env.local` on your machine and set
`ORBI_OWNER_PASSWORD` and `ORBI_DEVICE_TOKEN` to two different, strong random values.
Keep that file local.

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

## Device interface

The Pi uses its bearer token on these routes:

- `POST /api/device/heartbeat` with `{"esp32Connected":true}` after an ESP32
  responds to `HELLO` over serial. The Pi posts `false` if the ESP32 is absent.
- `GET /api/device/commands` to poll for pending pings.
- `POST /api/device/commands/<id>/result` with `{"ok":true}` after an ESP32 reply
  or `{"ok":false}` after a serial failure. The API expires pings after 60 seconds.
