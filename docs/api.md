# WAVE ROVER HTTP API

The installed Caddy endpoint on the Raspberry Pi exposes the versioned API over
HTTPS on port 443. The browser interface uses the same API. The machine-readable
OpenAPI description is available from the Rover at:

~~~text
https://wave-rover.local/api/v1/openapi.json
~~~

Use the Rover's current local DNS name `wave-rover.local`. Install
`/opt/wave-rover-control/wave-rover-root-ca.crt` as a trusted root certificate
on each client device. The API currently has no login or user arbitration.
Keep it on the Rover's trusted Wi-Fi or lab network; do not expose it to the
public internet. Development runs on port 8080 by default.

The browser page has an expandable, searchable endpoint guide. It summarizes
each route and links to the machine-readable specification below.

In the desktop layout, the camera/control divider can be dragged or adjusted
with the arrow keys. On narrow screens the two panels stack vertically.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Service and hardware status |
| `GET` | `/api/v1/status` | Combined service, drive, battery, and camera status |
| `GET` | `/api/v1/drive` | Drive connection and last requested wheel speeds |
| `POST` | `/api/v1/drive` | Set left/right wheel speeds with the deadman timer |
| `POST` | `/api/v1/drive/stop` | Request zero speed immediately |
| `GET` | `/api/v1/battery` | Battery voltage, rough percentage estimate, and feedback age |
| `GET` | `/api/v1/camera` | Camera state and selected dimensions |
| `POST` | `/api/v1/camera/resolution` | Select a camera preset |
| `GET` | `/api/v1/camera.mjpg` | Live MJPEG camera stream |
| `GET` | `/api/v1/autonomy/line` | Line detector and follower state |
| `POST` | `/api/v1/autonomy/line/config` | Apply HSV, ROI, mode, speed, and steering settings |
| `POST` | `/api/v1/autonomy/line/start` | Start following after line/camera/UART readiness checks |
| `POST` | `/api/v1/autonomy/line/stop` | Stop and disarm line following |
| `GET` | `/api/v1/autonomy/line/preview.mjpg` | Live color-detection overlay for the camera image |
| `GET` | `/api/v1/openapi.json` | OpenAPI 3.1 machine-readable contract |

All JSON request bodies require `Content-Type: application/json`. JSON status
responses use `application/json; charset=utf-8`.

## Drive motors

`POST /api/v1/drive` expects finite numeric `left` and `right` values from
`-1.0` through `1.0`. Values are clamped to `WAVER_MAX_SPEED`; the default
maximum is `0.5`, which is the Rover's full documented motor PWM range. A
successful response returns the applied values:

~~~http
POST /api/v1/drive HTTP/1.1
Content-Type: application/json

{"left":0.25,"right":0.25}
~~~

~~~json
{"accepted":true,"left":0.25,"right":0.25,"max_speed":0.5}
~~~

`accepted` means that the service validated and queued the bounded command. It
does not mean that wheel motion was measured. Use values from `-0.5` to `0.5`
for the full motor range at the default speed cap. Negative values reverse the
corresponding side.

Every nonzero command has a deadman lease. The default lease is 450 ms; the
service requests zero speed when the lease expires. A client that intends to
keep moving must renew its command at least every 150 ms and should send
`POST /api/v1/drive/stop` when it finishes. The stop endpoint needs no body.

~~~bash
curl -fsS -H 'Content-Type: application/json' \
  -d '{"left":0.25,"right":0.25}' \
  https://wave-rover.local/api/v1/drive
curl -fsS -X POST https://wave-rover.local/api/v1/drive/stop
~~~

The following standard-library Python example keeps renewing a slow forward
command, reads the battery voltage, and always requests a stop when the loop
ends. Run it only in a clear test area:

~~~python
import json
import time
from urllib.request import Request, urlopen

BASE_URL = "https://wave-rover.local"

def request(path, payload=None, method="GET"):
    body = json.dumps(payload).encode() if payload is not None else None
    headers = {"Content-Type": "application/json"} if body is not None else {}
    req = Request(BASE_URL + path, data=body, headers=headers, method=method)
    with urlopen(req, timeout=2) as response:
        return json.load(response)

print(request("/api/v1/battery"))
try:
    for _ in range(8):
        request("/api/v1/drive", {"left": 0.1, "right": 0.1}, "POST")
        time.sleep(0.1)
finally:
    request("/api/v1/drive/stop", method="POST")
~~~

`GET /api/v1/drive` and the `drive` object in the combined status include
`requested_speeds`. These are the latest requested values after the speed cap
and watchdog are applied; they are not encoder or measured motor speeds.

## Battery

`GET /api/v1/battery` returns the latest voltage from the ESP32's Waveshare
`T=1001` feedback. The Python service sends a `T=130` query about once per
second and reads the response through the same UART connection used for motor
commands.

~~~json
{
  "state":"available",
  "voltage_v":11.98,
  "charge_percent_estimate":80,
  "estimate_method":"generic_3s_li_ion_voltage_curve",
  "updated_age_s":0.32,
  "source":"waveshare_uart_t1001"
}
~~~

`state` is `waiting` before the first reading, `available` while the last
reading is no more than five seconds old, `stale` after that, or `disabled` if
the UART is disabled. When no valid reading has arrived, `voltage_v` and
`updated_age_s` are `null`.

`charge_percent_estimate` is a deliberately rough estimate rounded to 5%
steps. It maps pack voltage to a generic 3S, 4.2 V-per-cell Li-ion curve; it
is not a measurement from a battery gauge. Waveshare specifies three 18650
cells in series and a 12.6 V charger, but does not identify the exact cell
model. Cell chemistry, age, temperature, and especially motor load can shift
the result. Treat the displayed value as an orientation only, not as a safety
cutoff. The `estimate_method` field identifies this approximation. Both
`charge_percent_estimate` is `null` until a valid voltage reading arrives.

The current curve divides the measured pack voltage by three, linearly
interpolates these per-cell points, then rounds to the nearest 5%:

| Cell voltage | Estimate |
| ---: | ---: |
| 3.0 V | 0% |
| 3.3 V | 5% |
| 3.5 V | 10% |
| 3.6 V | 15% |
| 3.7 V | 25% |
| 3.8 V | 40% |
| 3.9 V | 60% |
| 4.0 V | 80% |
| 4.1 V | 90% |
| 4.2 V | 100% |

These points are a simple generic approximation, not a curve calibrated to the
installed cells. At the observed pack voltage of about 11.98 V, it returns
about 80% (`11.98 / 3 ≈ 3.99 V` per cell). Waveshare's [WAVE ROVER
documentation](https://www.waveshare.com/wiki/WAVE_ROVER) identifies the 3S
pack and charger. TI explains that an accurate estimate also depends on
current, resistance, temperature, and a relaxed open-circuit measurement, and
that the voltage curve changes with cell chemistry ([TI battery-gauging
note](https://www.ti.com/lit/an/slyt307/slyt307.pdf)).

The UART `T=1001` feedback does not report INA219 current or a calibrated
state-of-charge value. A better gauge would need current integration and
cell-specific characterization; the Waveshare firmware would need to expose
those readings to the Pi.

~~~bash
curl -fsS https://wave-rover.local/api/v1/battery
~~~

## Camera

`POST /api/v1/camera/resolution` accepts one of `vga`, `hd`, `full-hd`, or
`5mp`. Changing presets restarts capture briefly. The selection lasts until
the service restarts.

~~~json
{"preset":"full-hd"}
~~~

`GET /api/v1/camera` reports state, width, height, FPS, active preset, and
frame age. The MJPEG stream is at `/api/v1/camera.mjpg`.

## Autonomous line following

The Autonom browser page is served at `/autonomy`. It overlays the current
OpenCV HSV detection on the live camera image. The overlay is also available as
MJPEG at `/api/v1/autonomy/line/preview.mjpg`; cyan pixels passed the selected
threshold, black pixels are outside the mask, and the image center and ROI edge
are marked. The browser adds a yellow near-target point, a green averaged line
axis in single-line mode with a white far-end marker, and an orange arrow for the
requested turn direction. A legend below the image identifies the detected color,
near target, line axis, camera
centerline, and steering command. The browser screen-blends the black
background; cyan mask pixels and the center/ROI guides remain visible, while
target and steering guidance are drawn separately for clear visibility.

`GET /api/v1/autonomy/line` reports whether OpenCV is available, whether the
follower is active, its state, the applied settings, and current detection
measurements. The combined `/api/v1/status` response includes the same object
as `autonomy` and reports `mode` as `manual` or `autonomous`.
The `detection` object includes `line_detected`, the number of selected color
components, target x/y percentages in the camera image, the left/right boundary
positions for a line pair, the fitted line-axis endpoint percentages, signed
steering and heading errors, selected area, the fitted line angle in degrees,
analyzed frame size, ROI position, processing FPS, and frame age. When speed is
configured as `0`, an armed follower reports
`paused` and keeps both wheels stopped; stop it before changing its settings.

`POST /api/v1/autonomy/line/config` accepts a partial settings object and
merges it with the current values. Configuration is rejected with `409` while
the follower is active. Color presets are `white`, `black`, `yellow`, `red`,
`green`, `blue`, and `custom`. `line_mode` is `area`, `single`, or `between`
(the UI labels these Fläche, Linie, and Doppellinie); it defaults to `single`.
`area` follows the largest qualifying color component without a line-shape
filter. `single` follows the largest elongated component, using a minimum
long-to-short contour ratio of 2.2. `between` requires two separated elongated
components and treats them as course boundaries.
`between_strategy` is `midpoint` (the default) or `stay_between`; the latter
holds a straight course while the image center stays inside the detected
corridor, then steers back toward its nearest boundary. Hue uses OpenCV's 0–179
range; saturation and value use 0–255. Set `h_min` greater than `h_max` to
match hues that wrap through hue zero. The lower-frame analysis starts at
`roi_top_percent` (0–100); at 100%, only the bottom image row is analyzed.
`speed_percent` is 0–100, the steering gain is
0.2–2.5, and the minimum contour area is 0.05–5% of the analyzed region.

Example: apply the white single-line profile with a 15% requested motor speed
and analyze the lower 42% of the image:

~~~http
POST /api/v1/autonomy/line/config HTTP/1.1
Content-Type: application/json

{"color_preset":"white","line_mode":"single","speed_percent":15,"roi_top_percent":58}
~~~

This endpoint only updates the mask and control settings; it does not move the
Rover. `POST /api/v1/autonomy/line/start` takes no body and arms the follower
only when the latest processed frame detects the configured line, the camera is
online, and the drive UART is connected. A `409` response means the ready
conditions are not met; `503` means OpenCV is unavailable. Start from a low
speed and calibrate on a clear course.

The autonomy page can export the complete current settings as JSON, copy that
JSON to the clipboard, and import by pasting or loading a `.json` file. Its
portable wrapper has this shape:

~~~json
{
  "format": "wave-rover-line-detection",
  "version": 1,
  "settings": {
    "color_preset": "white",
    "line_mode": "single",
    "between_strategy": "midpoint",
    "h_min": 0,
    "h_max": 179,
    "s_min": 0,
    "s_max": 85,
    "v_min": 150,
    "v_max": 255,
    "roi_top_percent": 58,
    "speed_percent": 15,
    "steering_gain": 1.0,
    "min_area_percent": 0.15
  }
}
~~~

Import validates the wrapper and submits `settings` to the same configuration
endpoint. A partial `settings` object is accepted and keeps the Rover's
existing values for omitted fields. Import and upload are disabled while the
follower is active; exporting remains available.

For `single`, the detector follows the largest qualifying line-shaped
component, fits an axis through the central 60% of its visible length, and
combines the near end's lateral position with the fitted direction at equal
weight. The green preview segment shows this fit; the reported signed angle is
relative to the image's vertical axis. For `between`, it requires two separated
line-shaped components. `midpoint`
steers toward their average; `stay_between` leaves the target at the image
center while it is inside the corridor, then targets just inside the nearest
boundary. `line_detected` means that the configured HSV threshold and geometry
filter found a component for the chosen mode; it does not prove that the
component is a course marking. Inspect the camera overlay and target marker
before arming the Rover. In the browser, the heading pill shows the selected
mode, target's horizontal image position, and fitted line angle when available.
The orange arrow visualizes the requested wheel-speed correction: left means the
Rover would turn left, right means it would turn right, and the percentage is a
relative steering strength rather than a measured wheel or body angle.
Steering scales the configured speed by the signed error and gain; the follower
only requests forward wheel speeds. All commands still pass through
the configured `WAVER_MAX_SPEED` ceiling. If the line or fresh camera frames
are lost, the follower disarms and requests zero speed; it never resumes by
itself. Leaving the Autonom page or sending a manual drive command also
disarms it. Use `POST /api/v1/autonomy/line/stop` to stop it explicitly.

The runtime requires the Raspberry Pi OS `python3-opencv` package. The project
installer includes it and uses `--system-site-packages` for the service
virtual environment.

## Status and errors

`GET /api/v1/status` combines the service, drive, battery, and camera objects.
`/healthz` returns the same payload. API errors are JSON objects of the form
`{"error":"..."}`. Common HTTP status codes are:

- `400` for malformed JSON, invalid values, or unknown camera presets.
- `404` for an unknown endpoint.
- `413` for an oversized request body.
- `415` when a JSON endpoint receives another content type.

## Protocol and project boundary

Only the Python service opens the Rover UART. It sends bounded motor commands
to the ESP32 and polls the documented feedback command; clients must use the
HTTP API rather than opening `/dev/ttyAMA0` themselves. This keeps one owner
for the serial port and leaves student control code on the Pi.

The service has no CORS policy for arbitrary web origins. Local Python clients
can call the HTTP API directly. A browser client should be served from the
Rover origin (`https://wave-rover.local`) or explicitly be configured with a
separately reviewed CORS policy.
