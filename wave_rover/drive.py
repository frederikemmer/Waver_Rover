"""Fail-safe command handling for the Waveshare ESP32 rover controller."""

from __future__ import annotations

import json
import logging
import math
import threading
import time
from typing import Any

from .oled import OLEDStatus, _estimate_charge_percent

logger = logging.getLogger(__name__)


class DriveController:
    """Send bounded left/right speed commands over the rover GPIO UART."""

    def __init__(
        self,
        device: str,
        baud: int,
        max_speed: float,
        watchdog_ms: int,
    ) -> None:
        self.device = device.strip()
        self.baud = baud
        self.max_speed = max(0.0, min(0.5, float(max_speed)))
        self.watchdog_seconds = max(0.15, min(2.0, watchdog_ms / 1000.0))
        self._enabled = bool(self.device and self.device.lower() != "none")
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._stopping = threading.Event()
        self._desired = (0.0, 0.0)
        self._lease_until = 0.0
        self._serial: Any = None
        self._state = "starting" if self._enabled else "disabled"
        self._error: str | None = None
        self._thread: threading.Thread | None = None
        self._battery_voltage_v: float | None = None
        self._battery_seen_at: float | None = None
        self._oled = OLEDStatus()

    def start(self) -> None:
        if not self._enabled:
            return
        self._oled.start()
        self._thread = threading.Thread(
            target=self._run, name="rover-drive-uart", daemon=True
        )
        self._thread.start()

    def set_speeds(
        self, left: float, right: float, *, valid_until: float | None = None
    ) -> tuple[float, float]:
        """Set bounded speeds, optionally expiring before the usual watchdog."""
        if valid_until is not None and not math.isfinite(valid_until):
            raise ValueError("Command deadline must be finite.")
        bounded = (
            self._bounded(left),
            self._bounded(right),
        )
        with self._lock:
            self._desired = bounded
            self._lease_until = (
                time.monotonic() + self.watchdog_seconds
                if bounded != (0.0, 0.0)
                else 0.0
            )
            if valid_until is not None:
                self._lease_until = min(self._lease_until, valid_until)
        self._wake.set()
        return bounded

    def stop(self) -> None:
        self.set_speeds(0.0, 0.0)

    def status(self) -> dict[str, Any]:
        with self._lock:
            now = time.monotonic()
            if self._desired != (0.0, 0.0) and now >= self._lease_until:
                requested = (0.0, 0.0)
            else:
                requested = self._desired
            return {
                "state": self._state,
                "device": self.device if self._enabled else None,
                "error": self._error,
                "max_speed": self.max_speed,
                "watchdog_ms": round(self.watchdog_seconds * 1000),
                "requested_speeds": {"left": requested[0], "right": requested[1]},
            }

    def battery_status(self) -> dict[str, Any]:
        with self._lock:
            age = (
                max(0.0, time.monotonic() - self._battery_seen_at)
                if self._battery_seen_at is not None
                else None
            )
            voltage = self._battery_voltage_v

        if not self._enabled:
            state = "disabled"
        elif age is None:
            state = "waiting"
        elif age <= 5.0:
            state = "available"
        else:
            state = "stale"

        return {
            "state": state,
            "voltage_v": voltage,
            "charge_percent_estimate": _estimate_charge_percent(voltage),
            "estimate_method": "generic_3s_li_ion_voltage_curve",
            "updated_age_s": round(age, 2) if age is not None else None,
            "source": "waveshare_uart_t1001",
        }

    def close(self) -> None:
        self.stop()
        # Give the UART worker time to transmit the final zero-speed command.
        time.sleep(0.12)
        self._stopping.set()
        self._wake.set()
        if self._thread is not None:
            self._thread.join(timeout=1.0)
        self._close_serial()
        self._oled.close()

    def _bounded(self, value: float) -> float:
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("Wheel speed must be a finite number.")
        return max(-self.max_speed, min(self.max_speed, number))

    def _connect(self) -> None:
        import serial

        self._serial = serial.Serial(
            self.device,
            baudrate=self.baud,
            timeout=0.02,
            write_timeout=0.2,
            exclusive=True,
        )
        with self._lock:
            self._state = "connected"
            self._error = None
        logger.info("Drive controller connected on %s", self.device)

    def _close_serial(self) -> None:
        port, self._serial = self._serial, None
        if port is not None:
            try:
                port.close()
            except Exception:
                logger.debug("Error while closing rover UART", exc_info=True)

    def _current_command(self) -> tuple[float, float]:
        with self._lock:
            if self._desired != (0.0, 0.0) and time.monotonic() >= self._lease_until:
                self._desired = (0.0, 0.0)
            return self._desired

    def _read_feedback(self) -> None:
        if self._serial is None:
            return
        line = self._serial.readline()
        if not line:
            return
        try:
            payload = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            logger.debug("Ignoring non-JSON rover UART feedback: %r", line[:100])
            return
        if not isinstance(payload, dict) or payload.get("T") != 1001:
            return
        voltage = payload.get("v")
        if isinstance(voltage, bool) or not isinstance(voltage, (int, float)):
            return
        voltage = float(voltage)
        if not math.isfinite(voltage) or not 0.0 < voltage <= 20.0:
            return
        with self._lock:
            self._battery_voltage_v = voltage
            self._battery_seen_at = time.monotonic()

    def _run(self) -> None:
        last_sent: tuple[float, float] | None = None
        last_tx = 0.0
        next_feedback_request = 0.0
        next_oled_update = 0.0
        oled_line = 0

        while not self._stopping.is_set():
            try:
                if self._serial is None:
                    self._connect()
                    last_sent = None
                    next_oled_update = 0.0
                    oled_line = 0

                command = self._current_command()
                now = time.monotonic()
                changed = command != last_sent
                moving_heartbeat = command != (0.0, 0.0) and now - last_tx >= 0.1
                if changed or moving_heartbeat:
                    payload = json.dumps(
                        {"T": 1, "L": command[0], "R": command[1]},
                        separators=(",", ":"),
                    )
                    self._serial.write((payload + "\n").encode("utf-8"))
                    last_sent = command
                    last_tx = now

                if now >= next_feedback_request:
                    self._serial.write(b'{"T":130}\n')
                    next_feedback_request = now + 1.0

                self._read_feedback()

                # Keep metadata lookups off the motor/watchdog thread. Send at
                # most one short OLED command per iteration, after drive I/O.
                if now >= next_oled_update:
                    battery = self.battery_status()
                    voltage = battery["voltage_v"] if battery["state"] == "available" else None
                    lines = self._oled.lines(voltage)
                    payload = {"T": 3, "lineNum": oled_line, "Text": lines[oled_line]}
                    self._serial.write((json.dumps(payload) + "\n").encode("utf-8"))
                    oled_line = (oled_line + 1) % 4
                    if oled_line == 0:
                        self._oled.advance()
                    next_oled_update = now + (1.0 if oled_line == 0 else 0.1)

                with self._lock:
                    self._state = "connected"
                    self._error = None
            except Exception as exc:
                self._close_serial()
                with self._lock:
                    self._state = "offline"
                    self._error = str(exc)[:180]
                logger.warning("Drive UART unavailable: %s", exc)
                last_sent = None
                self._stopping.wait(1.0)
                continue

            self._wake.wait(0.03)
            self._wake.clear()

        self._close_serial()
