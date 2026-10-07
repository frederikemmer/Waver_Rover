"""Shared MJPEG stream sourced from the rover's UVC camera via FFmpeg."""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import threading
import time
from typing import Any

logger = logging.getLogger(__name__)

CAMERA_PRESETS = {
    "vga": (640, 480, "VGA"),
    "hd": (1280, 720, "HD"),
    "full-hd": (1920, 1080, "Full HD"),
    "5mp": (2592, 1944, "5 MP · maximum"),
}


class CameraStream:
    def __init__(
        self,
        device: str,
        width: int,
        height: int,
        fps: int,
    ) -> None:
        self.device = device.strip()
        self.width = max(160, min(2592, int(width)))
        self.height = max(120, min(1944, int(height)))
        self.fps = max(1, min(30, int(fps)))
        self._enabled = bool(self.device and self.device.lower() != "none")
        self._condition = threading.Condition()
        self._stopping = threading.Event()
        self._process: subprocess.Popen[bytes] | None = None
        self._thread: threading.Thread | None = None
        self._state = "starting" if self._enabled else "disabled"
        self._error: str | None = None
        self._sequence = 0
        self._latest_frame: bytes | None = None
        self._last_frame_at = 0.0
        self._revision = 0

    def start(self) -> None:
        if not self._enabled:
            return
        self._thread = threading.Thread(
            target=self._capture_loop, name="rover-camera", daemon=True
        )
        self._thread.start()

    def status(self) -> dict[str, Any]:
        with self._condition:
            age = (
                time.monotonic() - self._last_frame_at
                if self._last_frame_at
                else None
            )
            state = self._state
            if age is not None and age > 3.0:
                state = "offline"
            preset = next(
                (
                    name
                    for name, (width, height, _label) in CAMERA_PRESETS.items()
                    if (width, height) == (self.width, self.height)
                ),
                None,
            )
            return {
                "state": state,
                "device": self.device if self._enabled else None,
                "width": self.width,
                "height": self.height,
                "fps": self.fps,
                "preset": preset,
                "frame_age_ms": round(age * 1000) if age is not None else None,
                "error": self._error,
            }

    def set_preset(self, preset: str) -> dict[str, Any]:
        if not isinstance(preset, str) or preset not in CAMERA_PRESETS:
            raise ValueError("Choose one of the available camera presets.")
        width, height, _label = CAMERA_PRESETS[preset]
        process: subprocess.Popen[bytes] | None
        with self._condition:
            if (width, height) != (self.width, self.height):
                self.width = width
                self.height = height
                self._revision += 1
                self._last_frame_at = 0.0
                self._latest_frame = None
                self._error = None
                self._state = "connecting" if self._enabled else "disabled"
                process = self._process
                self._condition.notify_all()
            else:
                process = None
        if process is not None and process.poll() is None:
            try:
                process.terminate()
            except ProcessLookupError:
                pass
        return self.status()

    @property
    def stopping(self) -> bool:
        return self._stopping.is_set()

    def wait_for_frame(
        self, previous_sequence: int, timeout: float = 2.0
    ) -> tuple[int, bytes] | None:
        with self._condition:
            ready = self._condition.wait_for(
                lambda: (
                    self._sequence > previous_sequence
                    and self._latest_frame is not None
                )
                or self._stopping.is_set(),
                timeout=timeout,
            )
            if not ready or self._latest_frame is None:
                return None
            return self._sequence, self._latest_frame

    def close(self) -> None:
        self._stopping.set()
        with self._condition:
            process = self._process
            self._condition.notify_all()
        if process is not None and process.poll() is None:
            try:
                process.terminate()
            except ProcessLookupError:
                pass
        if self._thread is not None:
            self._thread.join(timeout=2.0)
        if process is not None and process.poll() is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        with self._condition:
            self._process = None

    def _capture_loop(self) -> None:
        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg is None:
            self._set_error("FFmpeg is not installed.")
            return

        while not self._stopping.is_set():
            with self._condition:
                revision = self._revision
                width = self.width
                height = self.height
            command = [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-f",
                "v4l2",
                "-input_format",
                "mjpeg",
                "-framerate",
                str(self.fps),
                "-video_size",
                f"{width}x{height}",
                "-i",
                self.device,
                "-an",
                "-c:v",
                "copy",
                "-f",
                "image2pipe",
                "-vcodec",
                "copy",
                "pipe:1",
            ]
            process: subprocess.Popen[bytes] | None = None
            try:
                process = subprocess.Popen(
                    command,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    bufsize=0,
                )
                with self._condition:
                    self._process = process
                    outdated = revision != self._revision
                    if not outdated:
                        self._state = "connecting"
                        self._error = None
                if outdated:
                    try:
                        process.terminate()
                    except ProcessLookupError:
                        pass
                else:
                    logger.info(
                        "Camera capture started on %s at %dx%d %d FPS",
                        self.device,
                        width,
                        height,
                        self.fps,
                    )
                    self._read_frames(process, revision)
                return_code = process.wait(timeout=1.0)
                with self._condition:
                    outdated = revision != self._revision
                if not self._stopping.is_set() and not outdated:
                    self._set_error(
                        "Camera stream ended (FFmpeg exit %d)." % return_code
                    )
            except FileNotFoundError:
                with self._condition:
                    outdated = revision != self._revision
                if not outdated:
                    self._set_error("The configured camera device was not found.")
            except subprocess.TimeoutExpired:
                if process is not None and process.poll() is None:
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
                with self._condition:
                    outdated = revision != self._revision
                if not outdated:
                    self._set_error("FFmpeg did not close cleanly.")
            except Exception as exc:
                with self._condition:
                    outdated = revision != self._revision
                if not outdated and not self._stopping.is_set():
                    self._set_error(str(exc)[:180])
                    logger.warning("Camera capture failed: %s", exc)
            finally:
                with self._condition:
                    if self._process is process:
                        self._process = None
                if process is not None and process.poll() is None:
                    process.kill()
            with self._condition:
                outdated = revision != self._revision
            if outdated:
                continue
            if not self._stopping.wait(2.0):
                continue

    def _read_frames(
        self, process: subprocess.Popen[bytes], revision: int
    ) -> None:
        if process.stdout is None:
            raise RuntimeError("FFmpeg camera output is unavailable.")

        buffer = bytearray()
        while not self._stopping.is_set():
            with self._condition:
                if revision != self._revision:
                    return
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                return
            buffer.extend(chunk)
            if len(buffer) > 4 * 1024 * 1024:
                start = buffer.find(b"\xff\xd8")
                if start < 0:
                    del buffer[:-1]
                elif start > 0:
                    del buffer[:start]

            while True:
                start = buffer.find(b"\xff\xd8")
                if start < 0:
                    if len(buffer) > 1:
                        del buffer[:-1]
                    break
                if start > 0:
                    del buffer[:start]
                end = buffer.find(b"\xff\xd9", 2)
                if end < 0:
                    break
                frame = bytes(buffer[: end + 2])
                del buffer[: end + 2]
                with self._condition:
                    if revision != self._revision:
                        return
                    self._latest_frame = frame
                    self._sequence += 1
                    self._last_frame_at = time.monotonic()
                    self._state = "online"
                    self._error = None
                    self._condition.notify_all()

    def _set_error(self, message: str) -> None:
        with self._condition:
            self._state = "offline"
            self._error = message
            self._condition.notify_all()
        logger.warning("Camera unavailable: %s", message)
