"""Local HTTP interface for the WAVE ROVER."""

from __future__ import annotations

import json
import logging
import math
import mimetypes
import os
import signal
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .camera import CameraStream
from .drive import DriveController
from .line_follower import (
    AutonomyNotReadyError,
    LineFollower,
    VisionUnavailableError,
)

logger = logging.getLogger("wave_rover")
WEB_DIR = Path(__file__).resolve().parent / "web"
API_SPEC_PATH = Path(__file__).resolve().parent.parent / "docs" / "openapi.json"
MAX_BODY_BYTES = 2048


class RoverHTTPServer(ThreadingHTTPServer):
    def handle_error(self, request: Any, client_address: Any) -> None:
        error = sys.exc_info()[1]
        if isinstance(error, (BrokenPipeError, ConnectionAbortedError, ConnectionResetError)):
            logger.debug("Client %s closed its connection", client_address)
            return
        super().handle_error(request, client_address)


def _int_setting(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        logger.warning("Invalid integer setting %s; using %d", name, default)
        return default


def _float_setting(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, default))
        if math.isfinite(value):
            return value
    except (TypeError, ValueError):
        pass
    logger.warning("Invalid numeric setting %s; using %s", name, default)
    return default


def _default_serial_device() -> str:
    try:
        model = Path("/proc/device-tree/model").read_text(errors="ignore").rstrip("\x00")
    except OSError:
        model = ""
    return "/dev/ttyAMA0" if "Raspberry Pi 5" in model else "/dev/serial0"


class RoverApplication:
    def __init__(self) -> None:
        self.drive = DriveController(
            device=os.environ.get("WAVER_SERIAL_DEVICE", _default_serial_device()),
            baud=_int_setting("WAVER_BAUD", 115200),
            max_speed=_float_setting("WAVER_MAX_SPEED", 0.5),
            watchdog_ms=_int_setting("WAVER_WATCHDOG_MS", 450),
        )
        self.camera = CameraStream(
            device=os.environ.get("WAVER_CAMERA_DEVICE", "/dev/video0"),
            width=_int_setting("WAVER_CAMERA_WIDTH", 640),
            height=_int_setting("WAVER_CAMERA_HEIGHT", 480),
            fps=_int_setting("WAVER_CAMERA_FPS", 15),
        )
        self.line_follower = LineFollower(self.camera, self.drive)

    def start(self) -> None:
        self.drive.start()
        self.camera.start()
        self.line_follower.start()

    def close(self) -> None:
        self.line_follower.close()
        self.camera.close()
        self.drive.close()

    def status(self) -> dict[str, Any]:
        return {
            "service": "online",
            "mode": "autonomous" if self.line_follower.active else "manual",
            "drive": self.drive.status(),
            "battery": self.drive.battery_status(),
            "camera": self.camera.status(),
            "autonomy": self.line_follower.status(),
        }


def make_handler(app: RoverApplication) -> type[BaseHTTPRequestHandler]:
    class RoverRequestHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self) -> None:
            path = urlsplit(self.path).path
            if path == "/":
                self._send_file("index.html")
            elif path in ("/autonomy", "/autonomy/"):
                self._send_file("autonomy.html")
            elif path == "/app.css":
                self._send_file("app.css")
            elif path == "/app.js":
                self._send_file("app.js")
            elif path == "/autonomy.js":
                self._send_file("autonomy.js")
            elif path in ("/api/v1/status", "/healthz"):
                self._send_json(200, app.status())
            elif path == "/api/v1/drive":
                self._send_json(200, app.drive.status())
            elif path == "/api/v1/battery":
                self._send_json(200, app.drive.battery_status())
            elif path == "/api/v1/camera":
                self._send_json(200, app.camera.status())
            elif path == "/api/v1/autonomy/line":
                self._send_json(200, app.line_follower.status())
            elif path == "/api/v1/openapi.json":
                self._send_openapi()
            elif path == "/api/v1/camera.mjpg":
                self._stream_camera()
            elif path == "/api/v1/autonomy/line/preview.mjpg":
                self._stream_line_preview()
            else:
                self._send_json(404, {"error": "Not found"})

        def do_POST(self) -> None:
            path = urlsplit(self.path).path
            if path == "/api/v1/drive/stop":
                app.line_follower.stop()
                app.drive.stop()
                self._send_json(200, {"accepted": True, "drive": app.drive.status()})
                return
            if path == "/api/v1/autonomy/line/config":
                payload = self._read_json_object()
                if payload is None:
                    return
                try:
                    result = app.line_follower.configure(payload)
                except AutonomyNotReadyError as exc:
                    self._send_json(409, {"error": str(exc)})
                    return
                except ValueError as exc:
                    self._send_json(400, {"error": str(exc)})
                    return
                self._send_json(200, {"accepted": True, "autonomy": result})
                return
            if path == "/api/v1/autonomy/line/start":
                try:
                    result = app.line_follower.start_following()
                except VisionUnavailableError as exc:
                    self._send_json(503, {"error": str(exc)})
                    return
                except AutonomyNotReadyError as exc:
                    self._send_json(409, {"error": str(exc)})
                    return
                self._send_json(200, {"accepted": True, "autonomy": result})
                return
            if path == "/api/v1/autonomy/line/stop":
                result = app.line_follower.stop()
                self._send_json(200, {"accepted": True, "autonomy": result})
                return
            if path == "/api/v1/camera/resolution":
                self._set_camera_resolution()
                return
            if path != "/api/v1/drive":
                self._send_json(404, {"error": "Not found"})
                return
            content_type = self.headers.get("Content-Type", "")
            if content_type.split(";", 1)[0].strip().lower() != "application/json":
                self._send_json(415, {"error": "Send application/json."})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self._send_json(400, {"error": "Invalid content length."})
                return
            if length < 1 or length > MAX_BODY_BYTES:
                self.close_connection = True
                self._send_json(413, {"error": "Invalid command size."})
                return
            try:
                payload = json.loads(self.rfile.read(length))
                left = self._wheel_value(payload, "left")
                right = self._wheel_value(payload, "right")
                app.line_follower.stop()
                bounded = app.drive.set_speeds(left, right)
            except (ValueError, TypeError, json.JSONDecodeError) as exc:
                self._send_json(400, {"error": str(exc)})
                return

            self._send_json(
                200,
                {
                    "accepted": True,
                    "left": bounded[0],
                    "right": bounded[1],
                    "max_speed": app.drive.max_speed,
                },
            )

        def _read_json_object(self) -> dict[str, Any] | None:
            content_type = self.headers.get("Content-Type", "")
            if content_type.split(";", 1)[0].strip().lower() != "application/json":
                self._send_json(415, {"error": "Send application/json."})
                return None
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self._send_json(400, {"error": "Invalid content length."})
                return None
            if length < 1 or length > MAX_BODY_BYTES:
                self.close_connection = True
                self._send_json(413, {"error": "Invalid request size."})
                return None
            try:
                payload = json.loads(self.rfile.read(length))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._send_json(400, {"error": "Invalid JSON body."})
                return None
            if not isinstance(payload, dict):
                self._send_json(400, {"error": "Send a JSON object."})
                return None
            return payload

        def _set_camera_resolution(self) -> None:
            content_type = self.headers.get("Content-Type", "")
            if content_type.split(";", 1)[0].strip().lower() != "application/json":
                self._send_json(415, {"error": "Send application/json."})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self._send_json(400, {"error": "Invalid content length."})
                return
            if length < 1 or length > MAX_BODY_BYTES:
                self.close_connection = True
                self._send_json(413, {"error": "Invalid request size."})
                return
            try:
                payload = json.loads(self.rfile.read(length))
                if not isinstance(payload, dict):
                    raise ValueError("Select a camera preset.")
                camera = app.camera.set_preset(payload.get("preset"))
            except (ValueError, TypeError, json.JSONDecodeError) as exc:
                self._send_json(400, {"error": str(exc)})
                return
            self._send_json(200, {"accepted": True, "camera": camera})

        @staticmethod
        def _wheel_value(payload: Any, name: str) -> float:
            if not isinstance(payload, dict) or name not in payload:
                raise ValueError("Both left and right wheel values are required.")
            value = payload[name]
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError("Wheel values must be numbers.")
            value = float(value)
            if not math.isfinite(value) or abs(value) > 1.0:
                raise ValueError("Wheel values must be between -1 and 1.")
            return value

        def _send_file(self, filename: str) -> None:
            path = WEB_DIR / filename
            try:
                content = path.read_bytes()
            except OSError:
                self._send_json(500, {"error": "Web page files are unavailable."})
                return
            content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
            self.send_response(200)
            self._security_headers()
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(content)

        def _send_json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self._security_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_openapi(self) -> None:
            try:
                content = API_SPEC_PATH.read_bytes()
            except OSError:
                self._send_json(500, {"error": "API specification is unavailable."})
                return
            self.send_response(200)
            self._security_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(content)

        def _stream_camera(self) -> None:
            self.send_response(200)
            self._security_headers()
            self.send_header(
                "Content-Type", "multipart/x-mixed-replace; boundary=frame"
            )
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            sequence = 0
            while True:
                item = app.camera.wait_for_frame(sequence)
                if item is None:
                    if app.camera.stopping or app.camera.status()["state"] == "disabled":
                        return
                    continue
                sequence, frame = item
                try:
                    self.wfile.write(
                        b"--frame\r\n"
                        b"Content-Type: image/jpeg\r\n"
                        + ("Content-Length: %d\r\n\r\n" % len(frame)).encode()
                        + frame
                        + b"\r\n"
                    )
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    return

        def _stream_line_preview(self) -> None:
            if not app.line_follower.available:
                self._send_json(503, {"error": "OpenCV line preview is unavailable."})
                return
            self.send_response(200)
            self._security_headers()
            self.send_header(
                "Content-Type", "multipart/x-mixed-replace; boundary=frame"
            )
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            sequence = 0
            while True:
                item = app.line_follower.wait_for_preview(sequence)
                if item is None:
                    if app.line_follower.stopping:
                        return
                    continue
                sequence, frame = item
                try:
                    self.wfile.write(
                        b"--frame\r\n"
                        b"Content-Type: image/jpeg\r\n"
                        + ("Content-Length: %d\r\n\r\n" % len(frame)).encode()
                        + frame
                        + b"\r\n"
                    )
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    return

        def _security_headers(self) -> None:
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; img-src 'self'; style-src 'self'; "
                "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; "
                "base-uri 'none'",
            )
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Frame-Options", "DENY")

        def log_message(self, fmt: str, *args: Any) -> None:
            logger.info("%s - %s", self.address_string(), fmt % args)

    return RoverRequestHandler


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("WAVER_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    app = RoverApplication()
    host = os.environ.get("WAVER_HOST", "0.0.0.0")
    port = _int_setting("WAVER_PORT", 8080)
    server = RoverHTTPServer((host, port), make_handler(app))
    server.daemon_threads = True
    app.start()

    def request_shutdown(signum: int, _frame: Any) -> None:
        logger.info("Received signal %s; stopping rover service", signum)
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, request_shutdown)
    signal.signal(signal.SIGINT, request_shutdown)
    logger.info("WAVE ROVER control listening on http://%s:%d", host, port)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
        app.close()


if __name__ == "__main__":
    main()
