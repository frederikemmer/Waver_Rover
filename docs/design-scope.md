# Design Scope and Roadmap

Last updated: 2026-10-06

This is the living product and technical scope for the WAVE ROVER student
project. Record later requirements and decisions here so that the intended
teaching use remains clear as the implementation changes.

## Goal

Provide an uncomplicated browser interface for controlling the rover from a
phone or laptop on the same local network. Python on the rover owns the
movement logic. The browser is a remote control and camera display; it does not
control GPIO, UART, or motors directly.

The project is intended for practical courses:

- Bachelor students: follow a line bounded by two white lines.
- Master students: drive a simple road course and respond to simple traffic
  signs.

The manual browser control is the first milestone and the shared foundation
for both courses. Camera-based line following is the current autonomy step;
traffic-sign behavior follows after the line course works reliably.

## Hardware baseline

| Part | Current choice |
| --- | --- |
| Rover | Waveshare WAVE ROVER |
| Host computer | Raspberry Pi 5, 8 GB |
| Camera | Waveshare IMX335 5 MP USB Camera B |
| Drive controller | Rover ESP32 controller connected over the Pi GPIO UART |
| Camera interface | USB video device through Linux V4L2 |

On Raspberry Pi 5, the controller uses `/dev/ttyAMA0` on GPIO 14/15 (40-pin
header pins 8/10), enabled by `dtoverlay=uart0-pi5`. Do not use `/dev/serial0`
for the WAVE ROVER on Pi 5: it points to the separate debug UART `/dev/ttyAMA10`.
Other Raspberry Pi models default to `/dev/serial0`. The camera is `/dev/video0`.
Configure device paths through the service environment rather than embedding
them in student code.

## Product behavior

### Manual control

- Open a local web page from a phone or laptop without installing a client.
- Show the forward camera image and connection state.
- Provide forward, reverse, rotate-left, and rotate-right controls that stop on
  release.
- Support touch, mouse, and keyboard input.
- Keep the W/A/S/D and arrow-key legend beside the control heading. Prevent
  long-press text selection and touch callouts on the direction buttons.
- Set the requested speed from 0–100% using either a slider or direct number entry.
- Select common camera resolutions through the camera's full sensor resolution.
- Keep the resolution selector beside the live-image title. Remove duplicate
  section labels, camera metadata footer text, and camera-frame corner marks.
- On desktop, place an adjustable splitter between the wider camera panel and
  the fixed-width control panel; support pointer dragging and keyboard arrows.
  Stack the panels and hide the splitter on narrow screens.
- Expose a versioned HTTP API for motor commands, battery telemetry, camera
  controls, and status, with a machine-readable OpenAPI contract.
- Show the coarse battery percentage estimate with the measured voltage beside
  it. Use `~` to mark the estimate and a subtle icon color for reading freshness.
  Omit separate battery labels and freshness text.
- Omit the extra press-to-drive instruction and the separate safety-status line;
  keep the keyboard key legend visible.
- Provide an expandable API guide with searchable endpoints, short explanations,
  and a link to the full OpenAPI specification.
- Keep speed bounded by a server-side limit.
- Stop when the user releases a control, the page loses focus, or command
  updates stop reaching the rover.
- Keep the interface usable on narrow phone screens and wider laptop screens.

### Autonomous line following

- Provide a separate Autonom page alongside manual control.
- Analyze camera frames on the Raspberry Pi in Python with OpenCV.
- Follow either one selected-color line or two same-color boundaries. Single
  line steering combines near-image lateral offset with a smaller look-ahead
  heading estimate to turn toward the line instead of tracking parallel to it.
- Offer color presets and live-image color picking. Picking samples a 5×5 pixel
  neighborhood, converts its median color to OpenCV HSV, and initializes three
  dual-ended ranges for hue, saturation, and brightness. Hue may wrap through
  179 to 0.
- For two boundaries, offer midpoint tracking and a corridor mode that steers
  inward only when the image center leaves the pair.
- Offer lower-image analysis region, minimum detected area, steering
  sensitivity, and forward speed.
- Keep the camera and mask in one resizable desktop column, with the controls
  alongside it. Keep the camera column at least 400 px wide and cap the
  settings column at 480 px so a wide settings panel cannot squeeze the mask.
  Preserve the mask image proportions and stack camera, settings, and mask on
  narrow screens.
- Keep autonomy disarmed by default. Start only after the current frame detects
  the configured line; stop immediately if the line or camera is lost.
- Stop autonomy when the page is left, when the manual drive API takes control,
  or when the user presses Stop.

### Responsibility split

| Component | Responsibility |
| --- | --- |
| Browser page | Display video and status; send short-lived manual requests; configure and start line following; select speed and camera resolution |
| Python web service | Validate API commands, enforce speed and timeout limits, expose status and battery telemetry, host the autonomous controller |
| Python drive adapter | Translate left/right wheel speeds and feedback queries into the Waveshare UART JSON protocol |
| Python line follower | Decode current camera frames, threshold HSV colors, find line position, and issue bounded differential-drive updates |
| ESP32 controller | Apply motor commands and handle low-level motor control |
| USB camera | Supply a local video stream for teleoperation and later vision work |

The web API is deliberately independent from the page so student programs can
send the same commands later. Keep camera processing, line following, and
traffic-sign state machines in Python modules on the rover.

## Current technical decisions

1. **Python serves the interface on the Pi.** This keeps the control path local
   to the rover and leaves students one language for web endpoints, camera
   processing, and behavior code.
2. **Use the existing Waveshare controller.** The Pi sends JSON commands to
   the ESP32 over GPIO UART; the Pi does not generate motor PWM itself.
3. **Use a narrow web service with one vision dependency.** HTTP and control
   use the Python standard library plus pyserial. FFmpeg reads the UVC camera
   and serves MJPEG; OpenCV decodes frames for the line follower. The package
   is installed from Raspberry Pi OS so the project stays reproducible without
   a pip build on the Rover.
4. **Use hold-to-run controls with a server-side deadman timeout.** A lost
   browser or Wi-Fi link must result in a stop request instead of a latched
   movement command. Releasing the held direction stops the Rover, so the
   interface does not need a separate stop button.
5. **Express speed as motor PWM percent.** The WAVE ROVER UART accepts
   `-0.5` to `+0.5`, where `0.5` is 100% PWM. The UI maps 0–100% to that range;
   the server retains an independent configurable cap.
6. **Keep one process in charge of the rover UART.** Do not run a second
   Waveshare or student drive process against the same serial device.
7. **Run as a systemd service on port 8080.** This avoids relying on a terminal
   remaining open and leaves Waveshare's usual port 5000 available if that
   software is later installed.
8. **Limit the current UI to a trusted local network.** There is no user login
   in this teaching prototype. Do not expose port 8080 to the public internet.
9. **Make the service API the student integration boundary.** Publish the
   endpoint contract as OpenAPI and keep sole ownership of the rover UART in
   the Python service.
10. **Report measured battery voltage without claiming an exact charge level.**
    The installed Waveshare UART feedback supplies pack voltage, not battery
    current or state-of-charge percentage.

## Roadmap

### M0 — Browser teleoperation (complete)

- Python HTTP server and versioned JSON API.
- Responsive control page, camera preview, and status.
- Hold-to-run touch, mouse, and keyboard controls.
- Stop-on-release, server-side speed cap, and deadman timeout.
- Reproducible Raspberry Pi install and systemd startup.
- Versioned HTTP API, OpenAPI document, and battery-voltage telemetry.
- Short, low-speed hardware verification on the raised rover.

### M1 — Bachelor line-following practical (current)

- Read camera frames in the Python OpenCV vision module.
- Detect one colored line or two same-color lane boundaries and estimate the
  rover's lateral error.
- Convert that error into bounded differential wheel commands while following.
- Tune color thresholds and the camera region from the browser's mask preview.
- Stop safely when the lane or camera is lost; require an explicit restart.
- Physically validate tracking on the raised Rover first, then at low speed on a
  clear, marked course.
- Document lighting, camera angle, lane width, and floor setup for repeatable
  exercises.

### M2 — Master traffic-sign practical

- Add recognition for a small, explicitly defined set of signs.
- Use a Python state machine to combine lane following with sign responses.
- Start with controlled signs and a closed course; define speed limits and
  stop behavior before adding more signs.
- Keep sign detection and driving policy separate so students can replace or
  compare each part.

### Later options

- Student-selectable behavior modes and a visible manual/autonomous mode state.
- Data logging and replay for camera frames and drive commands.
- A simulator or hardware-free development mode.
- Multiple rover profiles if the course uses different cameras or UART paths.

## Current constraints and open decisions

- The browser service is for a trusted lab network. Authentication and
  multi-user arbitration are not implemented.
- Corrected the differential-drive sign after the user found the left and right
  controls reversed. Physical left/right direction still needs confirmation.
- Only one browser client is expected to drive at a time. A later course setup
  may need an explicit control-owner lease.
- The rover does not currently expose measured wheel speed through this app;
  the UI must label commands as requested values rather than feedback.
- The ESP32 `T=1001` UART feedback reports pack voltage. The current firmware
  does not pass INA219 current to the Pi, so the percentage shown by this
  project is only a generic 3S Li-ion voltage estimate rounded to 5% steps.
  Battery cell type is unknown and the voltage falls under motor load; neither
  that estimate nor voltage alone is a safety cutoff. A more accurate gauge
  needs current feedback plus a cell-specific profile.
- The HTTP API has no authentication or client ownership lease; use it only on
  the trusted rover/lab network. See [api.md](api.md) for the complete API.
- Changing a camera preset restarts the UVC capture at the selected mode. The
  selection is runtime-only and returns to the configured startup resolution
  after the service restarts.
- OpenCV line following now runs on the Pi 5 at about 20 processed frames per
  second while the camera streams Full HD and the detector analyzes 640×360
  frames. Synthetic white single-line and two-boundary images pass. A physical
  floor-line course and steering direction have not yet been validated.
- The line-following controls now sample HSV from a point in the live image and
  use one dual-ended control for each HSV dimension. Single-line steering adds
  a near-to-far heading term; two-line mode can target the midpoint or remain
  inside the corridor. These steering changes are still awaiting physical
  course validation; autonomous movement has not been commanded.
- The autonomy layout now groups camera and mask into one left column, protects
  a 400 px minimum width, and caps the settings pane at 480 px. This keeps the
  mask aligned with the camera as the splitter moves and stacked on phones.
- The live view currently has one white-color component near 80% of image width.
  It has not been confirmed as a course line. Students must inspect the mask
  and target overlay before starting; color thresholding cannot distinguish a
  tape line from another object with the same color.
- Automatic speed uses the same configured motor ceiling as manual mode. The
  default autonomy speed is 15%; students can tune it from the Autonom page.
- The first camera view was nearly black. After the user removed the cap and
  aimed the camera at a lit area, current MJPEG frames became readable; the
  CSS placeholder overlay was also fixed.
- A serial device reporting `connected` confirms only that Linux opened a UART.
  It does not confirm that the UART is wired to the ESP32 or that the ESP32
  accepted a motion command. On Pi 5, the correct Rover UART is `/dev/ttyAMA0`
  with the `uart0-pi5` overlay.
- A brief 30% forward command on the raised Rover has now been physically
  confirmed to turn both sides, and both sides stopped after the control was
  released. Reverse and rotation still need separate physical confirmation.
- Camera defaults are 640×480 MJPEG at 15 FPS. Higher resolutions should be
  enabled only after measuring latency and CPU use on the Pi.
- The eventual GitHub owner/repository name and open-source license have not
  yet been selected. Update the one-command install line when the repository
  is published.

## External references

- [Waveshare WAVE ROVER product page](https://www.waveshare.com/product/wave-rover.htm)
- [Waveshare WAVE ROVER command protocol](https://www.waveshare.com/wiki/WAVE_ROVER)
- [Waveshare IMX335 5 MP USB Camera B product page](https://www.waveshare.com/imx335-5mp-usb-camera-b.htm)
- [Waveshare Raspberry Pi UGV software](https://github.com/waveshareteam/ugv_rpi)
- [Waveshare ESP32 UGV controller protocol](https://github.com/waveshareteam/ugv_base_general)
- [Waveshare INA219 voltage/current demo](https://www.waveshare.com/wiki/Tutorial_VII%3A_INA219_Voltage_And_Current_Monitoring_Demo)

The Waveshare Pi repository describes the Pi as the upper computer and the
ESP32 as the lower-level motion controller, communicating with JSON over GPIO
UART. This project keeps that hardware boundary and replaces the much broader
demo interface with a small student-oriented controller.

## Change log

| Date | Change |
| --- | --- |
| 2026-10-06 | Initial scope: manual browser control, Python-side drive logic, live USB camera, safety timeout, and Bachelor/Master autonomy roadmap. |
| 2026-10-06 | Corrected the Pi 5 UART mapping: the Rover uses `/dev/ttyAMA0` with `dtoverlay=uart0-pi5`; `/dev/serial0` is the separate debug UART. Added the camera placeholder visibility fix. |
| 2026-10-06 | The browser API initially sent commands to the Pi 5 debug UART. After switching to the GPIO UART and rebooting, a brief 30% forward command physically turned both sides; both stopped after release. Camera frames are visible after aiming at a lit area and fixing the placeholder CSS. |
| 2026-10-06 | Added runtime camera presets through 2592×1944, direct numeric speed entry from 0–100%, and removed the redundant stop button. The UI maps 100% to the WAVE ROVER controller's documented 0.5 command. |
| 2026-10-06 | Corrected the left/right differential-drive mapping after the user reported that the controls were reversed; physical confirmation is still pending. |
| 2026-10-06 | Added UART battery-voltage polling and display, a documented HTTP API and served OpenAPI contract, drive status/stop endpoints, and API scope notes. Current firmware feedback does not expose INA219 current or state-of-charge percentage. |
| 2026-10-06 | Added a second Autonom page, OpenCV line and two-boundary following, adjustable HSV/ROI/gain/speed settings, a live detection mask, and fail-stop behavior on line or camera loss. Physical line-course tuning remains to be done. |
| 2026-10-06 | Installed OpenCV on the Rover and verified the single-line and two-boundary detectors with synthetic images. A mock-drive run confirmed steering output and stop/disarm on line loss. The live camera is analyzed at about 20 FPS; no autonomous command has been sent to the physical Rover. |
| 2026-10-07 | Added live-image color picking, combined HSV range controls, corridor strategy selection, look-ahead steering, and a shared resizable camera/mask column. Verified through local/browser and synthetic image checks; no autonomous motor command was sent. |
