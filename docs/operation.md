# Installation and Operation

## Installation on Raspberry Pi OS

For a direct install from the public repository, run:

~~~bash
curl -fsSL https://github.com/frederikemmer/Waver_Rover/raw/master/install.sh | sudo bash
~~~

The installer fetches the current `master` branch by default. To install from a
checkout instead:

~~~bash
git clone https://github.com/frederikemmer/Waver_Rover.git
cd Waver_Rover
sudo bash ./install.sh
~~~

The installer installs FFmpeg, OpenCV, pyserial, and Python venv support, then
enables the systemd service for the invoking user. OpenCV is supplied by the
Raspberry Pi OS `python3-opencv` package and is visible inside the project's
system-site-packages virtual environment. The installer reserves the default
rover UART for the ESP32 by removing its serial console option from the next
boot's command line and masking the matching serial-getty service. SSH and
Wi-Fi or access point settings are unchanged. The current boot's serial-getty
is stopped immediately, and udev reapplies dialout permissions to the serial
device.

On Raspberry Pi 5, the WAVE ROVER connects to the 40-pin GPIO UART. The
installer selects `/dev/ttyAMA0` and adds `dtoverlay=uart0-pi5` to
`/boot/firmware/config.txt` when needed. Reboot once after the installer adds
that overlay so Linux can expose the UART on GPIO 14/15 (header pins 8/10).
The Pi 5 alias `/dev/serial0` points to its separate debug UART, so do not use
it for the Rover connection. On other Raspberry Pi models the default remains
`/dev/serial0`.

The serial port is then available to the rover controller rather than a login
shell. To restore serial console access later, remove the systemd mask and
restore the serial console option in /boot/firmware/cmdline.txt.

The installed Caddy service listens on HTTPS port 443 and redirects HTTP port
80 to HTTPS. Open https://wave-rover.local/ from a phone or laptop on the same
network. The certificate is issued by Caddy's local CA because `.local` names
cannot receive publicly trusted certificates. Install
`/opt/wave-rover-control/wave-rover-root-ca.crt` as a trusted root certificate
on each client device. On Windows, a current-user import can be done with
`certutil -user -addstore Root wave-rover-root-ca.crt`. On phones, import the
file as a CA/root certificate and enable full trust if the operating system
requires it. The Python app listens only on localhost at port 8080.

For an existing checkout, run `sudo bash ./install.sh` from the repository
root. Use `--repo URL` to install from a fork or another repository.

## Service

~~~bash
sudo systemctl status wave-rover-control@pi.service
sudo journalctl -u wave-rover-control@pi.service -f
sudo systemctl restart wave-rover-control@pi.service
sudo systemctl status caddy
sudo journalctl -u caddy -f
~~~

Caddy's configuration is in `/etc/caddy/Caddyfile`; the installer manages this
file and refuses to overwrite an unrelated Caddy configuration. Caddy renews
its local leaf certificate automatically and keeps the private CA key under
`/var/lib/caddy`. Only the root certificate is copied to the Rover app folder.

Configuration is in /etc/default/wave-rover-control:

- WAVER_HOST and WAVER_PORT: local backend bind address and port, default
  127.0.0.1:8080 behind Caddy
- WAVER_SERIAL_DEVICE: drive UART; `/dev/ttyAMA0` on Pi 5 and `/dev/serial0`
  on other Raspberry Pi models
- WAVER_CAMERA_DEVICE: UVC camera, default /dev/video0
- WAVER_MAX_SPEED: server-side wheel command cap in the UART scale, default 0.5
- WAVER_CAMERA_WIDTH and WAVER_CAMERA_HEIGHT: default 640×480
- WAVER_CAMERA_FPS: default 15

After editing the environment file, restart the service.

## HTTP API

The service exposes its OpenAPI 3.1 document at
`https://wave-rover.local/api/v1/openapi.json`; use the Rover's local hostname
if its hostname does not resolve. The complete human-readable contract and
examples are in [api.md](api.md).

Useful starting points:

- `GET /api/v1/status`: combined drive, battery, and camera state.
- `POST /api/v1/drive`: bounded left/right wheel command.
- `POST /api/v1/drive/stop`: immediate zero-speed request.
- `GET /api/v1/battery`: latest battery voltage feedback.
- `GET /api/v1/camera`: capture state and selected resolution.
- `POST /api/v1/camera/resolution`: change the camera preset.
- `GET /api/v1/camera.mjpg`: live camera stream.
- `GET /api/v1/autonomy/line`: line-detection and follower state.
- `POST /api/v1/autonomy/line/config`: apply color threshold and follower settings.
- `POST /api/v1/autonomy/line/start` and `/stop`: arm or stop the line follower.
- `GET /api/v1/autonomy/line/preview.mjpg`: color-detection overlay for the live view.
- `GET /healthz`: service and hardware status.

The motor API has a 450 ms deadman lease by default. Keep renewing any nonzero
command at least every 150 ms and call `/api/v1/drive/stop` when a client exits.
The UART is owned by this service; do not open it from a second program.

## Autonomous line following

Open `https://wave-rover.local/autonomy` or choose **Autonom** in the
header. The OpenCV color mask is overlaid on the live camera image; the checkbox
and **Deckkraft** slider control its visibility. Black parts of the MJPEG
preview blend through to the camera. Cyan areas match the current HSV
thresholds. In **Linie** mode, a bright green segment shows the averaged line
axis, the white dot its far end, and the yellow point its near target. The
dotted centerline is the Rover's forward reference; the orange arrow and
**Lenkbefehl** readout show the
requested turn direction and relative strength. This strength is not a measured
body angle. The legend below the image identifies each overlay. The vertical
**Suchstart** slider at the image edge moves the search-region boundary and its
matching horizontal image marker.

The initial profile detects white with H 0–179, S 0–85, and V 150–255. Other
presets cover black, yellow, red, green, and blue. To sample a color, choose
**Farbe im Livebild auswählen**, then tap the desired point in the camera image.
The page uses the median RGB color from a 5×5 pixel sample, converts it to
OpenCV HSV, and initializes a band around that sample. Low-saturation samples
use the full hue range. Three dual-ended controls set hue (0–179), saturation
(0–255), and brightness (0–255); each control shows its current Min/Max values
beside the heading. Hue may wrap through 179 to 0. Each larger endpoint marker
is filled with its current HSV color as it moves. The OpenCV ranges are noted
once beside the expandable
fine-tuning heading. Also tune the lower-image region (0–100%), minimum
component area (0.05–5%), steering gain (0.2–2.5), and speed (0–100%). At
100%, only the last image row is analyzed.

The color preview always shows the configured HSV minimum and maximum colors
and their H/S/V bounds, including before you pick a color. Expand
**Erkennungskonfiguration · JSON** to copy the current configuration to the
clipboard, download it as JSON, paste JSON into the text area, or load a JSON
file. The file uses the `wave-rover-line-detection` format at version `1` and
stores its settings under `settings`. **Konfiguration übernehmen** validates
and saves the imported values to the Rover. You can also import a partial
settings object; fields it does not contain keep their current values. Changes
are locked while autonomous following is active.

Choose **Fläche**, **Linie**, or **Doppellinie** as the detection mode. **Linie**
is selected by default and filters out broad color patches using the component
shape. Its steering combines the line position in the near image with a smaller
look-ahead estimate of line direction, so a parallel offset produces a
correction and bends can be anticipated. **Fläche** tracks the largest
qualifying color area without the line-shape filter. **Doppellinie** requires
two separated line-shaped components. Choose **Mittig zwischen den Linien** to
track their midpoint, or **Im Korridor bleiben** to continue straight while the
image center is between them and steer inward if it leaves.

Picking a color or changing a preset, HSV range, image region, or controller
value sends the new settings automatically after a short debounce. Start is
enabled only when the latest settings have been accepted and a fresh camera
frame detects a line. Settings are locked while following is active. The
default following speed is 15%. The camera is reduced to at most 640 pixels
wide for analysis, including when the live display uses Full HD.

Line following runs on the Pi and is disarmed by default. It stops when the
line disappears, the camera feed becomes stale, the page is left, or a manual
drive request takes over. After line or camera loss, realign the Rover and
press Start again; it does not resume by itself. Before running on a floor,
verify the color mask and steering direction with the wheels raised, then use a
clear marked course and low speed.

The battery display and endpoint read pack voltage from Waveshare feedback
`T=1001`; the service requests a reading with `T=130` once per second. Along
with volts, the UI and API show a rough percentage derived from a generic 3S
Li-ion voltage curve, rounded to 5% steps. It is not a calibrated state of
charge: motor load, cell chemistry, temperature, and cell age can shift it.
The current firmware does not expose INA219 current to this app, so the value
cannot be corrected for load and must not be used as a safety cutoff. See
[api.md](api.md#battery) for the calculation assumptions.

The autonomy page keeps the camera and settings in one resizable desktop row.
The divider keeps the camera side at least 400 px wide and limits the settings
side to 480 px. On narrow screens the camera and settings stack vertically.

The shared header places volts beside the approximate battery percentage,
marked with `~`. Freshness is indicated by the battery icon and tooltip;
separate battery labels and freshness text are omitted. The manual control
panel defaults to 380 px wide. On desktop, drag the divider or focus it and use
the arrow keys to adjust the split; on narrow screens the panels stack and the
divider is hidden. The expandable `API für Studierende` panel lists and filters
the available routes and links to `/api/v1/openapi.json`.

The Autonom heading shows the selected detection mode and, when a target is
found, its horizontal image position as a percentage. Detailed status remains
available through the status pill's accessible label and title.

## Manual controls

- Hold the on-screen direction buttons or use W/A/S/D and the arrow keys.
- The keyboard legend is beside the control heading. Direction symbols cannot
  be selected by a long press on touch screens.
- Releasing a button or key requests zero wheel speed.
- The Python service also requests zero speed after 450 ms without a fresh
  command.
- Set the requested motor PWM from 0–100% with the slider or numeric field.
- The WAVE ROVER UART uses `-0.5` to `+0.5`, with `0.5` representing 100% PWM.
  The server clamps each wheel command to WAVER_MAX_SPEED, whose default is
  `0.5` (the full documented range).
- Select VGA (640×480), HD (1280×720), Full HD (1920×1080), or 5 MP
  (2592×1944). The camera advertises all four modes as MJPEG at 30 FPS; this
  service currently captures at its configured 15 FPS. Switching modes
  restarts capture briefly. The selected mode resets to WAVER_CAMERA_WIDTH and
  WAVER_CAMERA_HEIGHT after a service restart.

The displayed drive state confirms UART availability only. It is not a measured
wheel-speed or position reading.

## Current rover observations

On 2026-10-06, after deploying the estimate, `/api/v1/battery` returned about
11.87 V and an estimated 70%, with `state: available` and a reading age below
one second. The camera was restored to 1920×1080 Full HD and remained online.
No nonzero motor command was sent during this check.

After the UI update on 2026-10-06, `/api/v1/status` reported the service online,
drive connected on `/dev/ttyAMA0` with both requested wheel speeds at zero,
battery at about 11.75 V / 65%, and the camera online at 1920×1080 and 15 FPS.
The browser received live frames. No nonzero motor command was sent. The desktop
splitter was checked by dragging the control panel from 380 px to 460 px and
back. At 390×844 px, the camera and controls stacked and the splitter was hidden.

On 2026-10-06, the rover was reachable over SSH. It reported Raspberry Pi OS
13, Python 3.13, and `/dev/serial0 -> /dev/ttyAMA10`. On this Pi 5,
`/dev/ttyAMA10` is the debug connector, not the Rover UART on GPIO pins 8/10.
Waveshare's Pi 5 sample uses `/dev/ttyAMA0` for the GPIO connection. The app
initially opened the debug UART and accepted browser commands without actually
controlling the ESP32. The installer now enables the Pi 5 `uart0-pi5` overlay
and selects `/dev/ttyAMA0`; a reboot is needed once when the overlay is added.
The USB camera is `/dev/video0` and advertises MJPEG modes including 640×480
and 1920×1080.

The current SSH host key is stored only in the developer's ignored .local
directory. Do not copy that host-specific file to another rover.

On 2026-10-06, OpenCV 4.10.0 was installed from Raspberry Pi OS. On this Pi OS
image, `python3-opencv` brought 72 packages and used about 519 MB of additional
disk space; the exact dependency size varies by OS image. The existing root
filesystem has ample free space after installation.

During that earlier Full HD check, the stream was analyzed as 640×360 frames at
about 20 FPS. With the initial white profile, the office view reported a
candidate colored component around 80% of image width. It was not confirmed as a floor
line. Inspect the mask and target marker before starting autonomous movement.
Synthetic 640×480 images with a single white line and with two white boundaries
both passed the detector and centered the target at approximately 50%. The
mock-drive run produced a steering correction and stopped/disarmed when the
synthetic line disappeared. The service API reported both physical wheel
requests at zero throughout; autonomous driving was not started. In-browser
layout checks passed at desktop width and a 390×844 phone viewport, including
the stacked panels and hidden splitter.

On 2026-10-07, the installed service was active on HTTP port 80. `/api/v1/status`
reported manual mode, `/dev/ttyAMA0` connected, both requested wheel speeds at
zero, autonomy inactive, and the camera online at 640×480 and 15 FPS. Battery
feedback was about 12.14 V with a rough 85% estimate. The default white single-
line detector reported a target near 54% of the image width and nine threshold
contours in the office view; these are not confirmed course markings. The API
accepted `area` and `between` settings, then the original `single` configuration
and 58% search start were restored. Synthetic frames on the Pi recognized one
vertical white line and two white boundaries near image center, rejected a
white square in `single` mode, and accepted it in `area` mode. Desktop and
390×844 phone layouts were reviewed after the UI update. No motor command was
sent and autonomy was not started.

The first installation also stopped and persistently masked
serial-getty@ttyAMA10 and removed the serial0 console entry from the next boot's
command line. That reserved the Pi 5 debug UART, which the first version
mistakenly treated as the controller UART. The updated installer reserves the
GPIO UART as well and adds the service user to `dialout`. SSH stayed available
throughout the correction.

The live browser page and API were checked from another network client. The
first version opened the Pi 5 debug UART, so its accepted browser requests did
not reach the Rover controller. The GPIO UART correction is now installed,
`dtoverlay=uart0-pi5` is active, and the service uses `/dev/ttyAMA0`. The user
physically confirmed that both sides turn during a brief 30% forward command
while the Rover was raised, and that both sides stop after the control is
released. Reverse and rotation have not yet been confirmed separately.
The user subsequently reported that left and right rotation were reversed; the
web control mapping has been corrected. Confirm both directions on the raised
Rover before lowering it.

The first camera view was nearly black. After the user removed the cap and
aimed the camera at a lit area, current 640×480 MJPEG frames became readable
(sampled mean brightness 132.7/255, maximum 189/255). The browser also showed
its waiting placeholder over a loaded image because CSS overrode the `hidden`
attribute. That CSS issue is fixed and the live image is now visible in the
browser.

## Safe verification

1. Raise the rover so the wheels cannot propel it.
2. Start with the lowest speed slider setting.
3. Confirm forward, reverse, and each rotation direction separately. Forward
   movement at 30% and stopping after release are confirmed on this Rover.
4. Disconnect the browser or leave the page and confirm the server timeout
   stops the wheels.
5. Lower the rover only after the directions and stop behavior are correct.

The same GPIO UART should not be opened by this service and another Waveshare
or student program at the same time.
