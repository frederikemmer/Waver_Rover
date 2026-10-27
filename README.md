# WAVE ROVER Student Control

Browser-based manual control and autonomous line following for the Waveshare
WAVE ROVER. The Python service handles control and image analysis on the
Raspberry Pi; Caddy serves the interface over local HTTPS. The phone or laptop
configures behavior and shows camera feedback.

## Current hardware

- Waveshare WAVE ROVER
- Raspberry Pi 5, 8 GB
- Waveshare IMX335 5 MP USB Camera B

The implementation uses the Waveshare controller's GPIO UART JSON protocol and
a local MJPEG camera stream. OpenCV analyzes color thresholds on the Pi. The
interface is intended for a trusted local network or the rover's own access
point.

## Install on the rover

For a direct install from the public repository, run:

~~~bash
curl -fsSL https://github.com/frederikemmer/Waver_Rover/raw/master/install.sh | sudo bash
~~~

The installer adds the Raspberry Pi OS OpenCV package and Caddy, creates a
Python virtual environment, and starts the Rover service behind Caddy. Open the
HTTPS address from a phone or laptop on the same network. For the OLED, the
installer reuses verified student credentials or asks for the existing Linux
login password without changing it. Run it from an interactive terminal.
The OLED continuously shows IP, hostname, `u: USER - p: PASSWORD`, and battery
percentage/volts. Long rows scroll; percentage is a rough voltage estimate.
After changing a login password outside the installers, rerun the installer
to update the displayed password.

Open:

~~~text
https://wave-rover.local/
~~~

For a clean student setup that updates Raspberry Pi OS without installing the
finished rover application, see [docs/student-setup.md](docs/student-setup.md).

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
- The **Autonom** page offers **Fläche**, **Linie** (default), and
  **Doppellinie** detection. Line modes filter for elongated color components;
  area tracking must be selected explicitly. The HSV detector overlays the live
  image, and settings apply automatically; the default speed is 15%.
- Battery voltage and a rough percentage estimate appear together in the shared
  header.
- Line following is disarmed by default. On line loss it holds the last steering
  command for up to 300 ms, then stops and disarms unless detection recovers.
  It also stops on stale camera frames, page exit, or manual control taking over.

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
