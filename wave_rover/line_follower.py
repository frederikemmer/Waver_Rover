"""OpenCV line detection and fail-stop differential-drive following."""

from __future__ import annotations

import logging
import math
import threading
import time
from typing import Any

from .camera import CameraStream
from .drive import DriveController

logger = logging.getLogger(__name__)

try:
    import cv2
    import numpy as np
except ImportError as exc:  # Keep manual driving usable if vision is not installed.
    cv2 = None
    np = None
    VISION_IMPORT_ERROR: str | None = str(exc)
else:
    VISION_IMPORT_ERROR = None


COLOR_PRESETS: dict[str, dict[str, int]] = {
    "white": {"h_min": 0, "h_max": 179, "s_min": 0, "s_max": 85, "v_min": 150, "v_max": 255},
    "black": {"h_min": 0, "h_max": 179, "s_min": 0, "s_max": 255, "v_min": 0, "v_max": 75},
    "yellow": {"h_min": 17, "h_max": 38, "s_min": 80, "s_max": 255, "v_min": 80, "v_max": 255},
    "red": {"h_min": 170, "h_max": 10, "s_min": 90, "s_max": 255, "v_min": 55, "v_max": 255},
    "green": {"h_min": 38, "h_max": 90, "s_min": 60, "s_max": 255, "v_min": 45, "v_max": 255},
    "blue": {"h_min": 90, "h_max": 135, "s_min": 60, "s_max": 255, "v_min": 45, "v_max": 255},
}

DEFAULT_CONFIG: dict[str, Any] = {
    "line_mode": "single",
    "between_strategy": "midpoint",
    "color_preset": "white",
    **COLOR_PRESETS["white"],
    "roi_top_percent": 58,
    "speed_percent": 15,
    "steering_gain": 1.0,
    "min_area_percent": 0.15,
}


class VisionUnavailableError(RuntimeError):
    """Raised when the optional OpenCV dependency is not installed."""


class AutonomyNotReadyError(RuntimeError):
    """Raised when following is requested without a usable line and drive."""


class LineFollower:
    """Continuously analyze camera frames; only drive after an explicit arm."""

    MAX_FRAME_WIDTH = 640
    FRAME_TIMEOUT_SECONDS = 0.6

    def __init__(self, camera: CameraStream, drive: DriveController) -> None:
        self.camera = camera
        self.drive = drive
        self._lock = threading.RLock()
        self._process_lock = threading.Lock()
        self._preview_ready = threading.Condition()
        self._stopping = threading.Event()
        self._thread: threading.Thread | None = None
        self._active = False
        self._state = "waiting_camera" if cv2 is not None else "vision_unavailable"
        self._error = VISION_IMPORT_ERROR
        self._config = dict(DEFAULT_CONFIG)
        self._config_revision = 0
        self._processed_revision = -1
        self._detection: dict[str, Any] = {
            "line_detected": False,
            "line_count": 0,
            "target_x_percent": None,
            "target_y_percent": None,
            "boundary_left_x_percent": None,
            "boundary_right_x_percent": None,
            "steering_error": None,
            "heading_error": None,
            "area_percent": 0.0,
            "fps": 0.0,
            "width": None,
            "height": None,
            "frame_age_ms": None,
        }
        self._last_frame_at = 0.0
        self._preview_sequence = 0
        self._preview_jpeg: bytes | None = None

    @property
    def active(self) -> bool:
        with self._lock:
            return self._active

    @property
    def available(self) -> bool:
        return cv2 is not None and np is not None

    @property
    def stopping(self) -> bool:
        return self._stopping.is_set()

    def start(self) -> None:
        if not self.available:
            self._state = "vision_unavailable"
            return
        self._thread = threading.Thread(
            target=self._process_loop, name="rover-line-vision", daemon=True
        )
        self._thread.start()

    def close(self) -> None:
        self.stop()
        self._stopping.set()
        with self._preview_ready:
            self._preview_ready.notify_all()
        if self._thread is not None:
            self._thread.join(timeout=2.0)

    def configure(self, payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ValueError("Linieneinstellungen müssen als JSON-Objekt gesendet werden.")
        unknown = set(payload) - set(DEFAULT_CONFIG)
        if unknown:
            raise ValueError("Unbekannte Einstellungen: " + ", ".join(sorted(unknown)))
        with self._lock:
            if self._active:
                raise AutonomyNotReadyError("Zum Ändern der Einstellungen zuerst die Linienfolge stoppen.")
            current = dict(self._config)

        config = dict(current)
        preset = payload.get("color_preset", config["color_preset"])
        if not isinstance(preset, str) or preset not in {*COLOR_PRESETS, "custom"}:
            raise ValueError("Unbekanntes Farbprofil.")
        if preset != config["color_preset"] and preset in COLOR_PRESETS:
            config.update(COLOR_PRESETS[preset])
        config["color_preset"] = preset

        mode = payload.get("line_mode", config["line_mode"])
        if mode not in ("single", "between"):
            raise ValueError("line_mode muss 'single' oder 'between' sein.")
        config["line_mode"] = mode

        strategy = payload.get("between_strategy", config["between_strategy"])
        if strategy not in ("midpoint", "stay_between"):
            raise ValueError("between_strategy muss 'midpoint' oder 'stay_between' sein.")
        config["between_strategy"] = strategy

        int_limits = {
            "h_min": (0, 179),
            "h_max": (0, 179),
            "s_min": (0, 255),
            "s_max": (0, 255),
            "v_min": (0, 255),
            "v_max": (0, 255),
            "roi_top_percent": (25, 85),
            "speed_percent": (0, 100),
        }
        for key, (minimum, maximum) in int_limits.items():
            raw = payload.get(key, config[key])
            if isinstance(raw, bool) or not isinstance(raw, (int, float)):
                raise ValueError(f"{key} muss eine ganze Zahl sein.")
            value = int(raw)
            if value != raw or not minimum <= value <= maximum:
                raise ValueError(f"{key} muss zwischen {minimum} und {maximum} liegen.")
            config[key] = value

        if config["s_min"] > config["s_max"] or config["v_min"] > config["v_max"]:
            raise ValueError("Bei Sättigung und Helligkeit muss Min. kleiner oder gleich Max. sein.")

        gain = payload.get("steering_gain", config["steering_gain"])
        if isinstance(gain, bool) or not isinstance(gain, (int, float)):
            raise ValueError("steering_gain muss eine Zahl sein.")
        gain = float(gain)
        if not math.isfinite(gain) or not 0.2 <= gain <= 2.5:
            raise ValueError("steering_gain muss zwischen 0.2 und 2.5 liegen.")
        config["steering_gain"] = round(gain, 2)

        area = payload.get("min_area_percent", config["min_area_percent"])
        if isinstance(area, bool) or not isinstance(area, (int, float)):
            raise ValueError("min_area_percent muss eine Zahl sein.")
        area = float(area)
        if not math.isfinite(area) or not 0.05 <= area <= 5.0:
            raise ValueError("min_area_percent muss zwischen 0.05 und 5 liegen.")
        config["min_area_percent"] = round(area, 2)

        with self._lock:
            self._config = config
            self._config_revision += 1
            self._state = "updating" if self.available else "vision_unavailable"
            self._error = VISION_IMPORT_ERROR
        return self.status()

    def start_following(self) -> dict[str, Any]:
        if not self.available:
            raise VisionUnavailableError("OpenCV fehlt. Installiere das Paket python3-opencv.")
        camera = self.camera.status()
        drive = self.drive.status()
        with self._lock:
            detection = dict(self._detection)
            frame_age = time.monotonic() - self._last_frame_at if self._last_frame_at else None
            ready = (
                self._processed_revision == self._config_revision
                and detection["line_detected"]
                and frame_age is not None
                and frame_age <= self.FRAME_TIMEOUT_SECONDS
            )
            if self._active:
                return self.status()
        if camera["state"] != "online":
            raise AutonomyNotReadyError("Die Kamera liefert noch kein Livebild.")
        if drive["state"] != "connected":
            raise AutonomyNotReadyError("Die UART-Verbindung zum Rover ist nicht bereit.")
        if not ready:
            raise AutonomyNotReadyError("Erst eine Linie im Erkennungsbild einstellen und abwarten.")

        self.drive.stop()
        with self._lock:
            self._active = True
            self._state = "following"
            self._error = None
        logger.info("Line following started with %s profile", self._config["color_preset"])
        return self.status()

    def stop(self) -> dict[str, Any]:
        with self._lock:
            was_active = self._active
            self._active = False
            if self._state not in ("vision_unavailable", "error", "camera_lost"):
                self._state = "ready" if self._detection["line_detected"] else "no_line"
        if was_active:
            self.drive.stop()
            logger.info("Line following stopped")
        return self.status()

    def status(self) -> dict[str, Any]:
        with self._lock:
            state = self._state
            if self._config_revision != self._processed_revision and self.available:
                state = "updating"
            frame_age = (
                max(0.0, time.monotonic() - self._last_frame_at)
                if self._last_frame_at
                else None
            )
            detection = dict(self._detection)
            config = dict(self._config)
            active = self._active
            error = self._error
        detection["frame_age_ms"] = round(frame_age * 1000) if frame_age is not None else None
        return {
            "available": self.available,
            "active": active,
            "state": state,
            "config": config,
            "detection": detection,
            "error": error,
        }

    def wait_for_preview(
        self, previous_sequence: int, timeout: float = 2.0
    ) -> tuple[int, bytes] | None:
        with self._preview_ready:
            ready = self._preview_ready.wait_for(
                lambda: self._preview_sequence > previous_sequence
                or self._stopping.is_set(),
                timeout=timeout,
            )
            if not ready or self._preview_jpeg is None:
                return None
            return self._preview_sequence, self._preview_jpeg

    def _process_loop(self) -> None:
        sequence = 0
        last_fps_at = 0.0
        while not self._stopping.is_set():
            item = self.camera.wait_for_frame(sequence, timeout=0.25)
            if item is None:
                self._stop_if_camera_lost()
                continue
            sequence, jpeg = item
            try:
                with self._process_lock:
                    with self._lock:
                        config = dict(self._config)
                        revision = self._config_revision
                    detection, mask_preview = self._analyze(jpeg, config)
                now = time.monotonic()
                if last_fps_at:
                    detection["fps"] = round(1.0 / max(0.001, now - last_fps_at), 1)
                last_fps_at = now
                with self._lock:
                    self._last_frame_at = now
                    self._processed_revision = revision
                    self._detection = detection
                    self._error = None
                    if self._active and not detection["line_detected"]:
                        self._active = False
                        self._state = "line_lost"
                        self.drive.stop()
                        must_stop = True
                    else:
                        must_stop = False
                        if self._active:
                            self._state = "paused" if config["speed_percent"] == 0 else "following"
                        else:
                            self._state = "ready" if detection["line_detected"] else "no_line"
                if mask_preview is not None:
                    with self._preview_ready:
                        self._preview_jpeg = mask_preview
                        self._preview_sequence += 1
                        self._preview_ready.notify_all()
                if must_stop:
                    logger.warning("Line lost; stopping autonomous drive")
                elif self.active and detection["line_detected"]:
                    self._send_follow_command(detection["steering_error"], config)
            except Exception as exc:
                logger.exception("Line detection failed")
                with self._lock:
                    self._active = False
                    self._state = "error"
                    self._error = str(exc)[:180]
                    self.drive.stop()

    def _stop_if_camera_lost(self) -> None:
        camera = self.camera.status()
        with self._lock:
            active = self._active
            age = time.monotonic() - self._last_frame_at if self._last_frame_at else None
            if active and (camera["state"] != "online" or age is None or age > self.FRAME_TIMEOUT_SECONDS):
                self._active = False
                self._state = "camera_lost"
                self._error = "Kamerabild veraltet oder nicht verfügbar."
                self.drive.stop()
                should_stop = True
            else:
                should_stop = False
        if should_stop:
            logger.warning("Camera frame lost; stopping autonomous drive")

    def _send_follow_command(self, steering_error: float | None, config: dict[str, Any]) -> None:
        # Serialize motor updates with stop/disarm so an in-flight vision frame
        # cannot issue a stale nonzero command after the user presses Stop.
        with self._lock:
            if not self._active:
                return
            if steering_error is None or config["speed_percent"] <= 0:
                self.drive.stop()
                return
            base_speed = self.drive.max_speed * config["speed_percent"] / 100.0
            correction = steering_error * config["steering_gain"] * base_speed
            left = max(0.0, min(self.drive.max_speed, base_speed - correction))
            right = max(0.0, min(self.drive.max_speed, base_speed + correction))
            self.drive.set_speeds(left, right)

    def _analyze(
        self, jpeg: bytes, config: dict[str, Any]
    ) -> tuple[dict[str, Any], bytes | None]:
        if cv2 is None or np is None:
            raise VisionUnavailableError("OpenCV ist nicht verfügbar.")
        frame = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            raise ValueError("Das Kamerabild konnte nicht decodiert werden.")
        height, width = frame.shape[:2]
        if width > self.MAX_FRAME_WIDTH:
            resized_height = max(1, round(height * self.MAX_FRAME_WIDTH / width))
            frame = cv2.resize(
                frame,
                (self.MAX_FRAME_WIDTH, resized_height),
                interpolation=cv2.INTER_AREA,
            )
            height, width = frame.shape[:2]

        roi_y = min(height - 1, max(0, round(height * config["roi_top_percent"] / 100)))
        roi = frame[roi_y:, :]
        hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
        lower = (config["h_min"], config["s_min"], config["v_min"])
        upper = (config["h_max"], config["s_max"], config["v_max"])
        if config["h_min"] <= config["h_max"]:
            mask = cv2.inRange(hsv, lower, upper)
        else:
            low_hue = cv2.inRange(
                hsv,
                (0, config["s_min"], config["v_min"]),
                (config["h_max"], config["s_max"], config["v_max"]),
            )
            high_hue = cv2.inRange(
                hsv,
                (config["h_min"], config["s_min"], config["v_min"]),
                (179, config["s_max"], config["v_max"]),
            )
            mask = cv2.bitwise_or(low_hue, high_hue)
        kernel = np.ones((3, 3), dtype=np.uint8)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

        contours, _hierarchy = cv2.findContours(
            mask.copy(), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        roi_area = max(1, mask.shape[0] * mask.shape[1])
        minimum_area = max(12.0, roi_area * config["min_area_percent"] / 100.0)
        maximum_area = roi_area * 0.55
        components: list[dict[str, Any]] = []
        for contour in contours:
            area = float(cv2.contourArea(contour))
            if not minimum_area <= area <= maximum_area:
                continue
            moments = cv2.moments(contour)
            if moments["m00"] <= 0:
                continue
            components.append({
                "x": float(moments["m10"] / moments["m00"]),
                "y": float(moments["m01"] / moments["m00"]),
                "area": area,
                "contour": contour,
            })

        selected: list[dict[str, Any]] = []
        target_x: float | None = None
        target_y: float | None = None
        target_area = 0.0
        if config["line_mode"] == "single":
            if components:
                selected = [max(components, key=lambda part: part["area"])]
        else:
            pairs: list[tuple[float, dict[str, Any], dict[str, Any]]] = []
            ordered = sorted(components, key=lambda part: part["x"])
            for index, left in enumerate(ordered):
                for right in ordered[index + 1:]:
                    separation = right["x"] - left["x"]
                    if width * 0.16 <= separation <= width * 0.9:
                        score = left["area"] + right["area"] + separation * 0.2
                        pairs.append((score, left, right))
            if pairs:
                _score, left, right = max(pairs, key=lambda pair: pair[0])
                selected = [left, right]

        if selected:
            if config["line_mode"] == "between" and len(selected) == 2:
                left_x, right_x = selected[0]["x"], selected[1]["x"]
                if config["between_strategy"] == "midpoint":
                    target_x = (left_x + right_x) / 2.0
                else:
                    image_center = width / 2.0
                    if left_x <= image_center <= right_x:
                        target_x = image_center
                    elif image_center < left_x:
                        target_x = left_x + (right_x - left_x) * 0.12
                    else:
                        target_x = right_x - (right_x - left_x) * 0.12
            else:
                target_x = selected[0]["x"]
            target_y = sum(part["y"] for part in selected) / len(selected)
            target_area = sum(part["area"] for part in selected)
        detected = target_x is not None
        steering_error = None
        heading_error = None
        if target_x is not None:
            steering_error = (width / 2.0 - target_x) / (width / 2.0)
            if config["line_mode"] == "single" and selected:
                contour_points = selected[0]["contour"].reshape(-1, 2)
                point_y = contour_points[:, 1]
                point_x = contour_points[:, 0]
                if len(point_y) >= 8 and float(point_y.max() - point_y.min()) >= 8:
                    near_cut = float(np.quantile(point_y, 0.72))
                    far_cut = float(np.quantile(point_y, 0.28))
                    near_points = point_x[point_y >= near_cut]
                    far_points = point_x[point_y <= far_cut]
                    near_x = float(np.median(near_points)) if len(near_points) else selected[0]["x"]
                    far_x = float(np.median(far_points)) if len(far_points) else selected[0]["x"]
                else:
                    near_x = far_x = selected[0]["x"]
                lateral_error = (width / 2.0 - near_x) / (width / 2.0)
                heading_error = max(-1.0, min(1.0, (near_x - far_x) / (width / 2.0)))
                # Weight the part nearest the Rover more strongly, then add a
                # smaller look-ahead term so an offset line and a bend both
                # produce a useful steering correction.
                steering_error = lateral_error * 1.15 + heading_error * 0.35
            steering_error = max(-1.0, min(1.0, steering_error))

        preview_mask = np.zeros((height, width), dtype=np.uint8)
        preview_mask[roi_y:, :] = mask
        preview = cv2.cvtColor(preview_mask, cv2.COLOR_GRAY2BGR)
        cv2.line(preview, (width // 2, 0), (width // 2, height - 1), (96, 96, 96), 1)
        cv2.line(preview, (0, roi_y), (width - 1, roi_y), (255, 160, 0), 1)
        if detected and target_x is not None and target_y is not None:
            point = (round(target_x), round(target_y + roi_y))
            cv2.circle(preview, point, 8, (0, 255, 0), 2)
            cv2.line(preview, (point[0] - 12, point[1]), (point[0] + 12, point[1]), (0, 255, 0), 2)
        encoded, buffer = cv2.imencode(
            ".jpg", preview, [int(cv2.IMWRITE_JPEG_QUALITY), 72]
        )
        preview_jpeg = buffer.tobytes() if encoded else None
        detection = {
            "line_detected": detected,
            "line_count": len(selected),
            "target_x_percent": round(target_x / width * 100, 1) if target_x is not None else None,
            "target_y_percent": round((target_y + roi_y) / height * 100, 1) if target_y is not None else None,
            "boundary_left_x_percent": (
                round(selected[0]["x"] / width * 100, 1)
                if config["line_mode"] == "between" and len(selected) == 2 else None
            ),
            "boundary_right_x_percent": (
                round(selected[1]["x"] / width * 100, 1)
                if config["line_mode"] == "between" and len(selected) == 2 else None
            ),
            "steering_error": round(steering_error, 4) if steering_error is not None else None,
            "heading_error": round(heading_error, 4) if heading_error is not None else None,
            "area_percent": round(target_area / roi_area * 100, 2),
            "contour_count": len(components),
            "width": width,
            "height": height,
            "roi_top_percent": config["roi_top_percent"],
        }
        return detection, preview_jpeg
