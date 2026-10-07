# WAVE ROVER Student Control

Browser-based manual control and autonomous line following for the Waveshare
WAVE ROVER. The web server, image analysis, and drive logic run on the Raspberry
Pi in Python. The phone or laptop configures behavior and shows camera feedback.

## Current hardware

- Waveshare WAVE ROVER
- Raspberry Pi 5, 8 GB
- Waveshare IMX335 5 MP USB Camera B

The implementation uses the Waveshare controller's GPIO UART JSON protocol and
a local MJPEG camera stream. OpenCV analyzes color thresholds on the Pi. The
interface is intended for a trusted local network or the rover's own access
point.

## Install on the rover

From a checkout on the Raspberry Pi:

~~~bash
sudo ./install.sh
~~~

The installer adds the Raspberry Pi OS OpenCV package, creates a Python virtual
environment, installs a systemd service, and starts it. The service listens on
port 8080. Open the address shown by the installer from a phone or laptop on
the same network, for example:

~~~text
http://wave-rover.local:8080
~~~

Once this repository has a GitHub location, the intended single-command install
is:

~~~bash
curl -fsSL https://raw.githubusercontent.com/OWNER/REPOSITORY/main/install.sh | sudo bash -s -- --repo https://github.com/OWNER/REPOSITORY.git
~~~

Replace OWNER and REPOSITORY with the published repository name.

## Local development

Run with Python 3.11 or later:

~~~bash
python -m wave_rover
~~~

For a development computer, set WAVER_SERIAL_DEVICE=none and
WAVER_CAMERA_DEVICE=none. No wheels will be driven in this mode. The app still
serves its page and reports the hardware as disabled.

## Safety behavior

- Movement buttons and keyboard controls are hold-to-run.
- Releasing a control sends a stop command.
- The Python service stops the wheels if browser updates stop arriving.
- Set speed from 0 to 100 percent with the slider or numeric field.
- The server applies its configured speed limit even if a client sends larger values.
- Choose a live camera preset from VGA through the camera's full 5 MP resolution.
- The **Autonom** page can follow one color line or stay centered between two
  same-color boundaries. Tune the HSV mask before starting; the default speed
  is 15%.
- Line following is disarmed by default and stops on line loss, stale camera
  frames, page exit, or manual control taking over.

The rover is a mobile platform. Verify the color mask and steering direction
with the wheels lifted, then use a clear marked course at low speed.

## Project notes

- [Design scope and roadmap](docs/design-scope.md)
- [Installation and operation](docs/operation.md)

The API and hardware adapter are intentionally small so students can study and
extend the Python code. The line detector and follower are in
`wave_rover/line_follower.py`; traffic-sign behavior remains a later milestone.

## API

The versioned HTTP API covers motor commands, stop, camera presets and stream,
line-following settings, status, and battery-voltage telemetry with a rough
voltage-based percentage estimate. Its OpenAPI 3.1 contract is served at
`/api/v1/openapi.json`; the readable guide is [docs/api.md](docs/api.md). The
percentage is an uncalibrated estimate because the ESP32 UART feedback reports
voltage but not INA219 current or battery-gauge state of charge.

The web interface includes an expandable, searchable guide to all API
endpoints, with short explanations and request examples. On desktop, drag the
divider between camera and controls to adjust their widths; on narrow screens
the panels stack vertically.
