import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

from wave_rover import oled, configure_oled
from wave_rover.drive import DriveController


class OLEDTests(unittest.TestCase):
    def test_four_rows_and_charge_match_web_estimate(self):
        self.assertEqual(oled.display_lines("192.168.1.42", "rover42.local", "pi", "abcd", 12.0), [
            "192.168.1.42", "rover42.local", "u: pi - p: abcd", "80 % - 12.00 V",
        ])
        self.assertEqual(oled.display_lines("offline", "rover42.local", "pi", "abcd", None)[3], "-- % - -- V")

    def test_long_values_never_wrap_and_scroll_reveals_password(self):
        text = "u: student_username - p: correct_password"
        frames = [oled.scroll(text, tick) for tick in range(100)]
        self.assertTrue(all(len(frame) <= 21 for frame in frames))
        self.assertTrue(any("correct_password" in frame for frame in frames))
        self.assertNotIn("\n", oled.scroll("bad\ntext", 0))

    def test_metadata_refresh_uses_live_hostname_network_and_credentials(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "credentials.json"
            with patch.object(oled, "credential_path", return_value=path), patch.object(oled, "current_ipv4", return_value="offline") as ip, patch.object(oled.socket, "gethostname", return_value="current"):
                status = oled.OLEDStatus()
                path.write_text(json.dumps({"username": "pi", "password": "first"}))
                status.refresh()
                self.assertEqual(status.lines(None)[0:2], ["offline", "current.local"])
                path.write_text(json.dumps({"username": "pi", "password": "next"}))
                ip.return_value = "10.0.0.2"
                status.refresh()
                self.assertEqual(status.lines(None)[0], "10.0.0.2")
                self.assertIn("next", status.lines(None)[2])
                path.unlink()
                status.refresh()
                self.assertEqual(status.lines(None)[2], "u: -- - p: --")

    def test_default_route_address_wins(self):
        addresses = [
            {"ifname": "eth0", "addr_info": [{"local": "10.0.0.2"}]},
            {"ifname": "wlan0", "addr_info": [{"local": "192.168.1.42"}]},
        ]
        results = [types.SimpleNamespace(stdout=json.dumps(addresses)), types.SimpleNamespace(stdout='[{"dev":"wlan0"}]')]
        with patch.object(oled.subprocess, "run", side_effect=results):
            self.assertEqual(oled.current_ipv4(), "192.168.1.42")

    def test_student_embedded_module_stays_identical_and_compiles(self):
        script = Path("student-setup.sh").read_text()
        start = script.index("cat >/usr/local/libexec/wave-rover-student-oled.py <<'PY'\n")
        embedded = script[start:].split("\n", 1)[1].split("\nPY\n", 1)[0]
        self.assertEqual(embedded, "#!/usr/bin/env python3\n" + Path("wave_rover/oled.py").read_text().rstrip())
        compile(embedded, "student-oled.py", "exec")
        # Also compile every other Python heredoc in the installer.
        for section in script.split("<<'PY'\n")[1:]:
            compile(section.split("\nPY\n", 1)[0], "student-generated.py", "exec")
        for installer in ("student-setup.sh", "install.sh"):
            subprocess.run(["bash", "-n", installer], check=True)

    def test_login_password_check_accepts_only_matching_unlocked_account(self):
        from unittest.mock import Mock
        library = Mock()
        library.crypt.return_value = b"$y$stored_hash"
        with patch.object(configure_oled.Path, "read_text", return_value="pi:$y$stored_hash:0:0:0:0:0:0:0"), patch.object(configure_oled.ctypes, "CDLL", return_value=library), patch.object(configure_oled.ctypes.util, "find_library", return_value="fake"):
            self.assertTrue(configure_oled.password_matches("pi", "matches"))
            library.crypt.return_value = b"$y$different_hash"
            self.assertFalse(configure_oled.password_matches("pi", "wrong"))
            self.assertFalse(configure_oled.password_matches("missing", "wrong"))
        with patch.object(configure_oled.Path, "read_text", return_value="pi:!locked:0:0:0:0:0:0:0"):
            self.assertFalse(configure_oled.password_matches("pi", "wrong"))

    def test_student_uart_polls_battery_and_hides_stale_readings(self):
        clock = [0.0]
        commands = []
        class Port:
            first = True
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def write(self, data):
                commands.append(json.loads(data))
            def flush(self):
                pass
            def readline(self):
                clock[0] += 0.21
                if self.first:
                    self.first = False
                    return b'{"T":1001,"v":12.0}\n'
                return b""
        def sleep(seconds):
            clock[0] += seconds
            if clock[0] > 8:
                raise KeyboardInterrupt
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "credentials.json"
            path.write_text('{"serial_device":"fake"}')
            with patch.object(oled, "CREDENTIALS", path), patch.object(oled.OLEDStatus, "start"), patch.object(oled.time, "sleep", side_effect=sleep), patch.object(oled.time, "monotonic", side_effect=lambda: clock[0]), patch.dict(sys.modules, {"serial": types.SimpleNamespace(Serial=lambda *a, **kw: Port())}), patch.object(sys, "argv", ["oled.py"]):
                with self.assertRaises(KeyboardInterrupt):
                    oled.main()
        battery_rows = [cmd["Text"] for cmd in commands if cmd["T"] == 3 and cmd["lineNum"] == 3]
        self.assertIn("80 % - 12.00 V", battery_rows)
        self.assertEqual(battery_rows[-1], "-- % - -- V")
        self.assertTrue(all(cmd["T"] in (3, 130) for cmd in commands))

    def test_web_uart_oled_keeps_watchdog_and_refreshes_battery(self):
        class Port:
            def __init__(self, *args, **kwargs):
                self.commands = []
            def write(self, data):
                self.commands.append((time.monotonic(), json.loads(data)))
            def readline(self):
                return b'{"T":1001,"v":12.0}\n'
            def close(self):
                pass
        port = Port()
        with patch.dict(sys.modules, {"serial": types.SimpleNamespace(Serial=lambda *a, **kw: port)}), patch.object(oled.OLEDStatus, "refresh"):
            drive = DriveController("fake", 115200, 0.5, 150)
            drive.set_speeds(0.2, 0.2)
            started = time.monotonic()
            drive.start()
            try:
                time.sleep(0.6)
            finally:
                drive.close()
        motors = [(stamp, cmd) for stamp, cmd in port.commands if cmd["T"] == 1]
        self.assertTrue(any(cmd["L"] == 0.2 for _, cmd in motors))
        stopped = next(stamp for stamp, cmd in motors if cmd["L"] == 0)
        self.assertLess(stopped - started, 0.4)
        rows = {cmd["lineNum"]: cmd["Text"] for _, cmd in port.commands if cmd["T"] == 3}
        self.assertEqual(set(rows), {0, 1, 2, 3})
        self.assertEqual(rows[3], "80 % - 12.00 V")
        self.assertTrue(all(len(text) <= 21 for text in rows.values()))


if __name__ == "__main__":
    unittest.main()
