"""Shared four-line OLED status for student setup and the web controller.

The 128x32 display uses the Adafruit size-1 font (21 columns). Longer
values scroll within their own row rather than wrapping into another row.
"""
from __future__ import annotations

import ipaddress
import json
import math
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

CREDENTIALS = Path("/etc/wave-rover-student/credentials.json")
COLUMNS = 21

# Approximate resting-voltage curve for a generic 4.2 V-per-cell Li-ion pack.
# The Rover uses three 18650 cells in series; its exact cell model is unknown.
_LI_ION_CELL_VOLTAGE_TO_PERCENT = (
    (3.0, 0),
    (3.3, 5),
    (3.5, 10),
    (3.6, 15),
    (3.7, 25),
    (3.8, 40),
    (3.9, 60),
    (4.0, 80),
    (4.1, 90),
    (4.2, 100),
)


def _estimate_charge_percent(voltage_v: float | None) -> int | None:
    """Estimate 3S Li-ion charge from pack voltage; this is not fuel gauging."""
    if voltage_v is None:
        return None

    cell_voltage = voltage_v / 3.0
    points = _LI_ION_CELL_VOLTAGE_TO_PERCENT
    if cell_voltage <= points[0][0]:
        return 0
    if cell_voltage >= points[-1][0]:
        return 100

    percent = 0.0
    for (low_voltage, low_percent), (high_voltage, high_percent) in zip(points, points[1:]):
        if cell_voltage <= high_voltage:
            portion = (cell_voltage - low_voltage) / (high_voltage - low_voltage)
            percent = low_percent + portion * (high_percent - low_percent)
            break

    # Five-point steps avoid suggesting more precision than the voltage curve
    # and unknown cell/load conditions can support.
    return max(0, min(100, int(math.floor(percent / 5.0 + 0.5)) * 5))


def current_ipv4():
    result = subprocess.run(
        ["ip", "-j", "-4", "addr", "show", "up", "scope", "global"],
        capture_output=True, text=True, timeout=2, check=True,
    )
    interfaces = json.loads(result.stdout)
    route = subprocess.run(
        ["ip", "-j", "-4", "route", "show", "default"],
        capture_output=True, text=True, timeout=2, check=True,
    )
    preferred = [item.get("dev") for item in json.loads(route.stdout)]
    interfaces.sort(key=lambda item: item.get("ifname") not in preferred)
    for interface in interfaces:
        for info in interface.get("addr_info", []):
            address = ipaddress.ip_address(info["local"])
            if not address.is_link_local and not address.is_loopback:
                return str(address)
    return "offline"


def credential_path():
    directory = os.environ.get("CREDENTIALS_DIRECTORY")
    return Path(directory) / "rover-oled" if directory else CREDENTIALS


def scroll(text, tick):
    text = "".join(char if 32 <= ord(char) < 127 else "?" for char in str(text))
    if len(text) <= COLUMNS:
        return text
    # Pause at each end so complete values can be read comfortably.
    end = len(text) - COLUMNS
    offset = max(0, min(end, tick % (end + 7) - 3))
    return text[offset:offset + COLUMNS]


def display_lines(ip, hostname, username, password, voltage, tick=0):
    percent = _estimate_charge_percent(voltage)
    battery = f"{percent} % - {voltage:.2f} V" if voltage is not None else "-- % - -- V"
    return [scroll(value, tick) for value in (
        ip, hostname, f"u: {username} - p: {password}", battery,
    )]


class OLEDStatus:
    """Refresh network and credentials without blocking the UART owner."""

    def __init__(self):
        self._values = ("offline", socket.gethostname().removesuffix(".local") + ".local", "--", "--")
        self._stopping = threading.Event()
        self._thread = None
        self._tick = 0

    def refresh(self):
        hostname = socket.gethostname().removesuffix(".local") + ".local"
        try:
            ip = current_ipv4()
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            ip = "offline"
        try:
            credentials = json.loads(credential_path().read_text(encoding="utf-8"))
            username = credentials["username"]
            password = credentials["password"]
        except (OSError, ValueError, KeyError, TypeError):
            username, password = "--", "--"
        self._values = (ip, hostname, username, password)

    def start(self):
        self._thread = threading.Thread(target=self._run, name="rover-oled-status", daemon=True)
        self._thread.start()

    def _run(self):
        while not self._stopping.is_set():
            self.refresh()
            self._stopping.wait(2)

    def lines(self, voltage):
        return display_lines(*self._values, voltage, tick=self._tick)

    def advance(self):
        self._tick += 1

    def close(self):
        self._stopping.set()
        if self._thread is not None:
            self._thread.join(timeout=5)


def send(port, payload):
    port.write((json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8"))
    port.flush()


def main():
    import serial

    credentials = json.loads(CREDENTIALS.read_text(encoding="utf-8"))
    status = OLEDStatus()
    status.start()
    try:
        with serial.Serial(credentials["serial_device"], baudrate=credentials.get("baudrate", 115200),
                          timeout=0.2, write_timeout=0.2, exclusive=True) as port:
            # Overwrite all custom rows; T=-3 merely restores the built-in
            # screen and leaves the previous custom row buffers intact.
            for row in range(4):
                send(port, {"T": 3, "lineNum": row, "Text": ""})
                time.sleep(0.1)
            if sys.argv[1:] == ["--reset"]:
                return
            voltage = None
            seen_at = 0
            while True:
                send(port, {"T": 130})
                deadline = time.monotonic() + 0.4
                while time.monotonic() < deadline:
                    try:
                        payload = json.loads(port.readline())
                    except (ValueError, UnicodeDecodeError):
                        continue
                    if not isinstance(payload, dict) or payload.get("T") != 1001:
                        continue
                    value = payload.get("v")
                    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 < value <= 20:
                        voltage, seen_at = float(value), time.monotonic()
                fresh_voltage = voltage if time.monotonic() - seen_at <= 5 else None
                for row, text in enumerate(status.lines(fresh_voltage)):
                    send(port, {"T": 3, "lineNum": row, "Text": text})
                    time.sleep(0.1)
                status.advance()
                time.sleep(0.2)
    finally:
        status.close()


if __name__ == "__main__":
    main()
