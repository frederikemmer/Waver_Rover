"""Record a verified existing login password for the device's OLED (root only)."""
from __future__ import annotations

import ctypes
import ctypes.util
import getpass
import hmac
import json
import os
import sys
from pathlib import Path

from .oled import CREDENTIALS


def password_matches(username, password):
    # libcrypt also supports YESCRYPT on Raspberry Pi OS with Python >= 3.13,
    # where Python's deprecated crypt/spwd modules no longer exist.
    entries = Path("/etc/shadow").read_text().splitlines()
    stored = next((line.split(":")[1] for line in entries if line.split(":")[0] == username), "!")
    if not stored or stored.startswith(("!", "*")):
        return False
    library = ctypes.CDLL(ctypes.util.find_library("crypt") or "libcrypt.so.1")
    library.crypt.argtypes = (ctypes.c_char_p, ctypes.c_char_p)
    library.crypt.restype = ctypes.c_char_p
    result = library.crypt(password.encode(), stored.encode())
    return bool(result) and hmac.compare_digest(result, stored.encode())


def main():
    username, device = sys.argv[1:]
    try:
        credentials = json.loads(CREDENTIALS.read_text())
    except (OSError, ValueError):
        credentials = {}
    password = credentials.get("password", "")
    if credentials.get("username") != username or not password_matches(username, password):
        print("OLED: Bitte das aktuelle Linux-Login-Passwort eingeben; es wird am Gerät angezeigt.", flush=True)
        # Explicit terminal access also works for the curl | sudo bash installer.
        try:
            with open("/dev/tty", "r+") as terminal:
                password = getpass.getpass("Aktuelles Login-Passwort: ", stream=terminal)
        except OSError:
            raise SystemExit("Kein Terminal für das OLED-Passwort. Installation aus einem interaktiven Terminal starten.")
        if not password_matches(username, password):
            raise SystemExit("Das eingegebene Passwort passt nicht zum Linux-Benutzer; bitte Installation erneut starten.")
    CREDENTIALS.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = CREDENTIALS.with_suffix(".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as output:
        json.dump({"username": username, "password": password, "serial_device": device, "baudrate": 115200}, output)
        output.write("\n")
    temporary.chmod(0o600)
    temporary.replace(CREDENTIALS)


if __name__ == "__main__":
    main()
