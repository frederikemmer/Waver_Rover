#!/usr/bin/env bash
set -euo pipefail

ENABLE_I2C=0
ENABLE_SPI=0
ENABLE_VNC=0
DEBUG=0
WIFI_SSID=
WIFI_PASSWORD=
WIFI_SSID_SET=0
WIFI_PASSWORD_SET=0

usage() {
    cat <<'EOF'
Usage: student-setup.sh [--debug] [--wifi-ssid SSID --wifi-password PASSWORD]
                        [--enable-i2c] [--enable-spi] [--enable-vnc]

Updates Raspberry Pi OS and prepares SSH, Python, Git, and the WAVE ROVER OLED.
It assigns a checked roverXX.local hostname and a short classroom SSH password.
By default, it shows a progress bar with an estimated remaining time. --debug
prints the setup command output. Wi-Fi options connect before package updates.
The Wi-Fi password may be visible in shell history and the process list while
the command runs; use these options only in a trusted setup session.
EOF
}

die() {
    printf 'Fehler: %s\n' "$*" >&2
    exit 1
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --enable-i2c) ENABLE_I2C=1 ;;
        --enable-spi) ENABLE_SPI=1 ;;
        --enable-vnc) ENABLE_VNC=1 ;;
        --debug) DEBUG=1 ;;
        --wifi-ssid)
            [ "$#" -ge 2 ] || die "Für --wifi-ssid fehlt der WLAN-Name."
            WIFI_SSID=$2
            WIFI_SSID_SET=1
            shift 2
            continue
            ;;
        --wifi-password)
            [ "$#" -ge 2 ] || die "Für --wifi-password fehlt das WLAN-Passwort."
            WIFI_PASSWORD=$2
            WIFI_PASSWORD_SET=1
            shift 2
            continue
            ;;
        --help|-h) usage; exit 0 ;;
        *) die "Unbekannte Option: $1 (siehe --help)" ;;
    esac
    shift
done

if [ "$WIFI_SSID_SET" -ne "$WIFI_PASSWORD_SET" ]; then
    die "--wifi-ssid und --wifi-password müssen zusammen angegeben werden."
fi
if [ "$WIFI_SSID_SET" -eq 1 ] && { [ -z "$WIFI_SSID" ] || [ -z "$WIFI_PASSWORD" ]; }; then
    die "WLAN-Name und WLAN-Passwort dürfen nicht leer sein."
fi
ROVER_USER=${SUDO_USER:-}

STEP_LABELS=()
STEP_WEIGHTS=()
add_progress_step() {
    STEP_LABELS+=("$1")
    STEP_WEIGHTS+=("$2")
}

add_progress_step "System und Rover prüfen" 10
if [ "$WIFI_SSID_SET" -eq 1 ]; then
    add_progress_step "Mit dem WLAN verbinden" 45
fi
add_progress_step "Paketlisten aktualisieren" 90
add_progress_step "Raspberry Pi OS aktualisieren" 300
add_progress_step "Rover-Werkzeuge installieren" 100
add_progress_step "Schnittstellen & SSH einrichten" 25
add_progress_step "Hostname im Netzwerk setzen" 25
add_progress_step "Rover-UART vorbereiten" 15
add_progress_step "SSH-Passwort festlegen" 30
add_progress_step "OLED & Zugangsdaten vorbereiten" 25
add_progress_step "Dienste & OLED aktualisieren" 40
add_progress_step "SSH-Zugang fertigstellen" 10
TOTAL_STEPS=${#STEP_LABELS[@]}
TOTAL_STEP_WEIGHT=0
for weight in "${STEP_WEIGHTS[@]}"; do
    TOTAL_STEP_WEIGHT=$((TOTAL_STEP_WEIGHT + weight))
done

PROGRESS_INDEX=0
setup_progress_step() {
    PROGRESS_INDEX=$((PROGRESS_INDEX + 1))
    if [ "$DEBUG" -eq 1 ]; then
        printf '\n[%02d/%02d] %s\n' "$PROGRESS_INDEX" "$TOTAL_STEPS" "$1"
    else
        printf 'STEP|%s|%s\n' "$PROGRESS_INDEX" "$1" >&3
    fi
}

setup_progress_wait() {
    if [ "$DEBUG" -eq 1 ]; then
        printf 'Passworteingabe im Terminal; die Fortschrittsanzeige pausiert.\n'
    else
        printf 'WAIT\n' >&3
        sleep 0.2
        printf '\r\033[2K\n' >/dev/tty 2>/dev/null || true
    fi
}

read_secret() {
    local variable_name=$1
    local prompt=$2
    local secret
    if [ "$DEBUG" -eq 1 ]; then
        read -r -s -p "$prompt" secret </dev/tty
    else
        printf '%s' "$prompt" >/dev/tty
        IFS= read -r -s secret </dev/tty
    fi
    printf '\n' >/dev/tty
    printf -v "$variable_name" '%s' "$secret"
}

setup_result() {
    if [ "$DEBUG" -eq 0 ]; then
        printf 'RESULT|%s|%s\n' "$1" "${2:-}" >&3
    fi
}

format_eta() {
    local seconds=$1
    if [ "$seconds" -lt 60 ]; then
        printf '<1 min'
    elif [ "$seconds" -lt 3600 ]; then
        printf '%d min' "$((seconds / 60))"
    else
        printf '%d h %02d min' "$((seconds / 3600))" "$(((seconds % 3600) / 60))"
    fi
}

render_progress() {
    local step_index=$1
    local label=$2
    local elapsed=$3
    local eta_factor=$4
    local completed_weight=0
    local remaining_weight=0
    local current_weight=0
    local predicted_current=0
    local current_progress=0
    local progress_percent=0
    local eta_seconds=0
    local filled=0
    local bar=
    local index
    local frame
    local frames=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)

    for ((index = 0; index < step_index - 1; index++)); do
        completed_weight=$((completed_weight + STEP_WEIGHTS[index]))
    done
    current_weight=${STEP_WEIGHTS[step_index - 1]}
    for ((index = step_index; index < TOTAL_STEPS; index++)); do
        remaining_weight=$((remaining_weight + STEP_WEIGHTS[index]))
    done

    predicted_current=$((current_weight * eta_factor / 100))
    [ "$predicted_current" -gt 0 ] || predicted_current=1
    current_progress=$((elapsed * 100 / predicted_current))
    [ "$current_progress" -le 85 ] || current_progress=85
    progress_percent=$(((completed_weight + current_weight * current_progress / 100) * 100 / TOTAL_STEP_WEIGHT))
    eta_seconds=$((predicted_current - elapsed + remaining_weight * eta_factor / 100))
    if [ "$eta_seconds" -lt 5 ]; then
        eta_seconds=5
    fi

    filled=$((progress_percent * 12 / 100))
    for ((index = 0; index < 12; index++)); do
        if [ "$index" -lt "$filled" ]; then
            bar+="█"
        else
            bar+="░"
        fi
    done
    frame=${frames[$((SECONDS % ${#frames[@]}))]}

    if [ -t 1 ]; then
        printf '\r\033[2K\033[36m%s\033[0m \033[32m[%s]\033[0m %3d%%  \033[2mETA ~%s\033[0m  %s' \
            "$frame" "$bar" "$progress_percent" "$(format_eta "$eta_seconds")" "$label"
    elif [ "$label" != "${LAST_PRINTED_LABEL:-}" ]; then
        printf '[%s] %3d%%  ETA ~%s  %s\n' \
            "$bar" "$progress_percent" "$(format_eta "$eta_seconds")" "$label"
        LAST_PRINTED_LABEL=$label
    fi
}

run_setup() {
setup_progress_step "System und Rover prüfen"
if [ "$(id -u)" -ne 0 ]; then
    die "Bitte mit sudo starten, zum Beispiel: sudo bash ./student-setup.sh"
fi
command -v apt-get >/dev/null 2>&1 || die "apt-get wurde nicht gefunden; benötigt wird Raspberry Pi OS."
command -v systemctl >/dev/null 2>&1 || die "systemd wurde nicht gefunden."

ROVER_USER=${SUDO_USER:-}
if [ -z "$ROVER_USER" ] || [ "$ROVER_USER" = root ] || ! id "$ROVER_USER" >/dev/null 2>&1; then
    die "Starte das Script mit sudo aus dem normalen Raspberry-Pi-Benutzerkonto, damit ich den richtigen SSH-Benutzer verwenden kann."
fi

ACTIVE_ROVER_SERVICES=$(systemctl list-units --type=service --state=active --plain --no-legend \
    'wave-rover-control@*.service' 2>/dev/null | awk '{print $1}' || true)
if [ -n "$ACTIVE_ROVER_SERVICES" ]; then
    die "Der Rover-Control-Dienst läuft bereits ($ACTIVE_ROVER_SERVICES). Stoppe ihn zuerst, damit das OLED-Script den UART sicher verwenden kann."
fi

# A previous continuous OLED writer must release UART before replacement/reset.
if systemctl is-active --quiet wave-rover-student-oled.service; then
    systemctl stop wave-rover-student-oled.service
fi

ROVER_MODEL=$(tr -d '\0' </proc/device-tree/model 2>/dev/null || true)
BOOT_CONFIG=
SERIAL_DEVICE=/dev/serial0
if [[ "$ROVER_MODEL" == *"Raspberry Pi 5"* ]]; then
    SERIAL_DEVICE=/dev/ttyAMA0
    if [ -f /boot/firmware/config.txt ]; then
        BOOT_CONFIG=/boot/firmware/config.txt
    elif [ -f /boot/config.txt ]; then
        BOOT_CONFIG=/boot/config.txt
    else
        die "Die Raspberry-Pi-Bootdatei config.txt wurde nicht gefunden."
    fi

    if ! grep -Eq '^[[:space:]]*dtoverlay[[:space:]]*=[[:space:]]*uart0-pi5([,[:space:]]|$)' "$BOOT_CONFIG"; then
        cat >>"$BOOT_CONFIG" <<'EOF'

# WAVE ROVER: expose GPIO14/15 as UART0 for the ESP32 controller.
[pi5]
dtoverlay=uart0-pi5
[all]
EOF
        printf 'Die GPIO-UART-Konfiguration wurde in %s ergänzt.\n' "$BOOT_CONFIG"
        printf 'Bitte jetzt sudo reboot ausführen und danach dieses Script erneut starten.\n'
        setup_result REBOOT "$BOOT_CONFIG"
        return 0
    fi
fi

[ -e "$SERIAL_DEVICE" ] || die "$SERIAL_DEVICE fehlt. Prüfe die UART-Konfiguration und starte den Rover gegebenenfalls neu."
UART_TTY=$(basename "$(readlink -f "$SERIAL_DEVICE")")
[ -n "$UART_TTY" ] || die "Das serielle Gerät $SERIAL_DEVICE konnte nicht aufgelöst werden."

if { [ "$ENABLE_I2C" -eq 1 ] || [ "$ENABLE_SPI" -eq 1 ] || [ "$ENABLE_VNC" -eq 1 ]; } && ! command -v raspi-config >/dev/null 2>&1; then
    die "Für die angeforderten Interface-Optionen wird raspi-config benötigt."
fi
if [ "$WIFI_SSID_SET" -eq 1 ]; then
    if command -v nmcli >/dev/null 2>&1 && systemctl is-active --quiet NetworkManager; then
        WIFI_METHOD=nmcli
    elif command -v raspi-config >/dev/null 2>&1; then
        WIFI_METHOD=raspi-config
    else
        die "Für die WLAN-Einrichtung wird NetworkManager (nmcli) oder raspi-config benötigt."
    fi
fi

if [ "${#ROVER_USER}" -gt 15 ]; then
    die "Der Benutzername ist länger als 15 Zeichen und passt nicht vollständig auf das OLED."
fi

SSHD_DROP_IN=/etc/ssh/sshd_config.d/00-wave-rover-student.conf
if [ -e "$SSHD_DROP_IN" ] && ! grep -q '^# Managed by WAVE ROVER student-setup.sh$' "$SSHD_DROP_IN"; then
    die "$SSHD_DROP_IN existiert bereits und wird nicht vom WAVE ROVER Script verwaltet."
fi

if [ "$WIFI_SSID_SET" -eq 1 ]; then
    setup_progress_step "Mit dem WLAN verbinden"
    if [ "$WIFI_METHOD" = nmcli ]; then
        nmcli --wait 90 device wifi connect "$WIFI_SSID" password "$WIFI_PASSWORD"
    else
        raspi-config nonint do_wifi_ssid_passphrase "$WIFI_SSID" "$WIFI_PASSWORD"
        if [ -f /etc/wpa_supplicant/wpa_supplicant.conf ]; then
            chmod 0600 /etc/wpa_supplicant/wpa_supplicant.conf
        fi
        for attempt in {1..60}; do
            if ip -4 route show default | grep -q .; then
                break
            fi
            sleep 1
        done
        if ! ip -4 route show default | grep -q .; then
            die "Das WLAN wurde eingerichtet, aber es gibt keine IPv4-Standardroute. Prüfe WLAN-Name, Passwort und WLAN-Land."
        fi
    fi
    unset WIFI_PASSWORD
fi

setup_progress_step "Paketlisten aktualisieren"
apt-get update

setup_progress_step "Raspberry Pi OS aktualisieren"
DEBIAN_FRONTEND=noninteractive apt-get full-upgrade -y

setup_progress_step "Rover-Werkzeuge installieren"
DEBIAN_FRONTEND=noninteractive apt-get install -y \
    avahi-daemon avahi-utils git openssh-server python3 python3-pip python3-serial \
    python3-setuptools python3-venv
apt-get autoremove -y

setup_progress_step "Schnittstellen & SSH einrichten"
if [ "$ENABLE_I2C" -eq 1 ]; then
    raspi-config nonint do_i2c 0
fi
if [ "$ENABLE_SPI" -eq 1 ]; then
    raspi-config nonint do_spi 0
fi
if [ "$ENABLE_VNC" -eq 1 ]; then
    if raspi-config nonint do_vnc 0; then
        printf 'VNC wurde aktiviert.\n'
    else
        printf 'Hinweis: Diese Raspberry-Pi-OS-Version konnte VNC nicht über raspi-config aktivieren.\n' >&2
    fi
fi

if command -v raspi-config >/dev/null 2>&1; then
    raspi-config nonint do_ssh 0
    if [[ "$ROVER_MODEL" != *"Raspberry Pi 5"* ]]; then
        raspi-config nonint do_serial_cons 1
        raspi-config nonint do_serial_hw 0
    fi
fi

install -d -m 0755 /etc/ssh/sshd_config.d
cat >"$SSHD_DROP_IN" <<'EOF'
# Managed by WAVE ROVER student-setup.sh
PasswordAuthentication yes
EOF
sshd -t
systemctl enable --now ssh
systemctl reload ssh

setup_progress_step "Hostname im Netzwerk setzen"
TARGET_HOSTNAME="rover$(python3 -c 'import secrets; print(f"{secrets.randbelow(100):02d}")')"
hostnamectl set-hostname "$TARGET_HOSTNAME"
systemctl enable --now avahi-daemon
systemctl restart avahi-daemon

setup_progress_step "Rover-UART vorbereiten"
usermod -aG dialout "$ROVER_USER"

BOOT_CMDLINE=/boot/firmware/cmdline.txt
if [ ! -f "$BOOT_CMDLINE" ]; then
    BOOT_CMDLINE=/boot/cmdline.txt
fi
if [ -f "$BOOT_CMDLINE" ]; then
    sed -i -E 's/(^| )console=(serial0|ttyAMA[0-9]+|ttyS[0-9]+),[0-9]+ / /g' "$BOOT_CMDLINE"
fi
systemctl mask --now "serial-getty@${UART_TTY}.service"
if [ -e "/sys/class/tty/$UART_TTY" ]; then
    udevadm trigger --action=add "/sys/class/tty/$UART_TTY"
fi
udevadm settle

setup_progress_step "SSH-Passwort festlegen"
setup_progress_wait
if [ "$DEBUG" -eq 1 ]; then
    printf '\nNeues SSH-Passwort für %s eingeben; Enter erzeugt ein zufälliges vierstelliges Passwort.\n' "$ROVER_USER"
else
    printf '\nNeues SSH-Passwort für %s eingeben; Enter erzeugt ein zufälliges vierstelliges Passwort.\n' "$ROVER_USER" >/dev/tty
fi
read_secret NEW_PASSWORD 'Neues Passwort: '
if [ -z "$NEW_PASSWORD" ]; then
    NEW_PASSWORD=$(python3 -c 'import secrets; alphabet="abcdefghjkmnpqrstuvwxyz23456789"; print("".join(secrets.choice(alphabet) for _ in range(4)))')
    printf 'Ein zufälliges SSH-Passwort wurde erzeugt und wird auf dem OLED angezeigt.\n'
else
    if [[ ! "$NEW_PASSWORD" =~ ^[abcdefghjkmnpqrstuvwxyz23456789]{4}$ ]]; then
        die "Das Passwort muss genau vier Kleinbuchstaben oder Ziffern enthalten; i, l, o, 0 und 1 sind ausgeschlossen."
    fi
    read_secret PASSWORD_CONFIRM 'Neues Passwort wiederholen: '
    [ "$NEW_PASSWORD" = "$PASSWORD_CONFIRM" ] || die "Die Passwörter stimmen nicht überein."
    unset PASSWORD_CONFIRM
fi

# Apply the password before publishing it on the display or to credentials.json.
printf '%s:%s\n' "$ROVER_USER" "$NEW_PASSWORD" | chpasswd --crypt-method YESCRYPT

setup_progress_step "OLED & Zugangsdaten vorbereiten"
install -d -m 0700 /etc/wave-rover-student
install -d -m 0755 /usr/local/libexec
umask 077
ROVER_STUDENT_USERNAME="$ROVER_USER" \
ROVER_STUDENT_HOSTNAME="$TARGET_HOSTNAME" \
ROVER_STUDENT_PASSWORD="$NEW_PASSWORD" \
ROVER_STUDENT_SERIAL_DEVICE="$SERIAL_DEVICE" \
python3 - <<'PY'
import json
import os
from pathlib import Path

path = Path("/etc/wave-rover-student/credentials.json")
data = {
    "username": os.environ["ROVER_STUDENT_USERNAME"],
    "hostname": os.environ["ROVER_STUDENT_HOSTNAME"],
    "password": os.environ["ROVER_STUDENT_PASSWORD"],
    "serial_device": os.environ["ROVER_STUDENT_SERIAL_DEVICE"],
    "baudrate": 115200,
}
with path.open("w", encoding="utf-8") as credentials:
    json.dump(data, credentials)
    credentials.write("\n")
os.chmod(path, 0o600)
PY

cat >/usr/local/libexec/wave-rover-student-hostname.py <<'PY'
#!/usr/bin/env python3
import ipaddress
import json
import random
import re
import subprocess
import time
from pathlib import Path

CREDENTIALS = Path("/etc/wave-rover-student/credentials.json")


def command(args, timeout=8):
    return subprocess.run(args, text=True, capture_output=True, timeout=timeout, check=False)


def local_ipv4_addresses():
    result = command(["ip", "-o", "-4", "addr", "show", "up", "scope", "global"])
    addresses = set()
    for line in result.stdout.splitlines():
        fields = line.split()
        if "inet" not in fields:
            continue
        value = fields[fields.index("inet") + 1].split("/", 1)[0]
        address = ipaddress.ip_address(value)
        if not address.is_link_local:
            addresses.add(str(address))
    return addresses


def resolve_ipv4(hostname):
    result = command(["avahi-resolve-host-name", "-4", f"{hostname}.local"])
    if result.returncode != 0:
        if "timeout" in (result.stdout + result.stderr).lower():
            return set()
        raise RuntimeError(f"Avahi konnte {hostname}.local nicht prüfen: {result.stderr.strip()}")
    addresses = set()
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) >= 2:
            try:
                addresses.add(str(ipaddress.ip_address(fields[-1])))
            except ValueError:
                pass
    return addresses


def is_available(hostname, local_addresses):
    resolved = resolve_ipv4(hostname)
    return not resolved or bool(local_addresses) and resolved.issubset(local_addresses)


def write_credentials(hostname):
    data = json.loads(CREDENTIALS.read_text(encoding="utf-8"))
    data["hostname"] = hostname
    temporary = CREDENTIALS.with_suffix(".tmp")
    temporary.write_text(json.dumps(data) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(CREDENTIALS)


def main():
    current = subprocess.run(
        ["hostnamectl", "--static"], text=True, capture_output=True, check=True
    ).stdout.strip()
    local_addresses = local_ipv4_addresses()

    if re.fullmatch(r"rover[0-9]{2}", current):
        if not local_addresses:
            print("Kein IPv4-Netz aktiv; der vorhandene Hostname bleibt bis zum nächsten Boot erhalten.")
            write_credentials(current)
            return
        resolved = resolve_ipv4(current)
        if not resolved:
            time.sleep(1)
            resolved = resolve_ipv4(current)
        if not resolved or resolved.issubset(local_addresses):
            write_credentials(current)
            return

    candidates = [f"rover{number:02d}" for number in random.SystemRandom().sample(range(100), 100)]
    for candidate in candidates:
        if candidate == current or not is_available(candidate, local_addresses):
            continue
        subprocess.run(["hostnamectl", "set-hostname", candidate], check=True)
        subprocess.run(["systemctl", "restart", "avahi-daemon"], check=True)
        time.sleep(1)

        # Recheck after Avahi announces the name in case another Rover chose it
        # at the same time.
        resolved = set()
        for attempt in range(3):
            local_addresses = local_ipv4_addresses()
            resolved = resolve_ipv4(candidate)
            if resolved:
                break
            time.sleep(1)
        if resolved and local_addresses and not resolved.issubset(local_addresses):
            current = candidate
            continue
        write_credentials(candidate)
        return

    raise SystemExit("Kein freier Hostname rover00–rover99 im lokalen mDNS-Netz gefunden.")


if __name__ == "__main__":
    main()
PY
chmod 0755 /usr/local/libexec/wave-rover-student-hostname.py

cat >/usr/local/libexec/wave-rover-student-oled.py <<'PY'
#!/usr/bin/env python3
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
PY
chmod 0755 /usr/local/libexec/wave-rover-student-oled.py

setup_progress_step "Dienste & OLED aktualisieren"
cat >/etc/systemd/system/wave-rover-student-oled.service <<'EOF'
[Unit]
Description=Show WAVE ROVER SSH connection details on the OLED
Wants=wave-rover-student-oled-reset.service
After=systemd-udev-settle.service wave-rover-student-oled-reset.service
ConditionPathExists=/etc/wave-rover-student/credentials.json

[Service]
Type=simple
ExecStart=/usr/bin/python3 /usr/local/libexec/wave-rover-student-oled.py
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/wave-rover-student-oled-reset.service <<'EOF'
[Unit]
Description=Clear the previous WAVE ROVER OLED overlay early at boot
After=systemd-udev-settle.service
Before=wave-rover-student-hostname.service wave-rover-student-oled.service
ConditionPathExists=/etc/wave-rover-student/credentials.json

[Service]
Type=oneshot
TimeoutStartSec=20
ExecStart=/usr/bin/python3 /usr/local/libexec/wave-rover-student-oled.py --reset

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/wave-rover-student-hostname.service <<'EOF'
[Unit]
Description=Check and assign a free WAVE ROVER mDNS hostname
Wants=network-online.target
Requires=avahi-daemon.service
After=network-online.target avahi-daemon.service
ConditionPathExists=/etc/wave-rover-student/credentials.json

[Service]
Type=oneshot
TimeoutStartSec=300
ExecStart=/usr/bin/python3 /usr/local/libexec/wave-rover-student-hostname.py

[Install]
WantedBy=multi-user.target
EOF

install -d -m 0755 /etc/systemd/system/wave-rover-control@.service.d
cat >/etc/systemd/system/wave-rover-control@.service.d/10-student-oled.conf <<'EOF'
[Unit]
Conflicts=wave-rover-student-oled.service wave-rover-student-oled-reset.service
After=wave-rover-student-oled.service wave-rover-student-oled-reset.service
EOF

systemctl daemon-reload
systemctl enable wave-rover-student-oled-reset.service
systemctl enable wave-rover-student-hostname.service
systemctl start wave-rover-student-oled-reset.service
systemctl start wave-rover-student-hostname.service
TARGET_HOSTNAME=$(python3 -c 'import json; print(json.load(open("/etc/wave-rover-student/credentials.json"))["hostname"])')
systemctl enable wave-rover-student-oled.service
systemctl restart wave-rover-student-oled.service

setup_progress_step "SSH-Zugang fertigstellen"
unset NEW_PASSWORD

printf '\nVorbereitung abgeschlossen.\n'
printf 'SSH: ssh %s@%s.local\n' "$ROVER_USER" "$TARGET_HOSTNAME"
printf 'Das Passwort steht auf dem Rover-OLED.\n'
printf 'Verbinde Pi und Laptop mit demselben vertrauenswürdigen Netzwerk.\n'
printf 'Starte den Rover neu, damit alle Updates und UART-Einstellungen sicher aktiv sind: sudo reboot\n'
if [ -f /var/run/reboot-required ]; then
    printf 'Das Betriebssystem meldet zusätzlich, dass ein Neustart erforderlich ist.\n'
fi
setup_result DONE "$TARGET_HOSTNAME"
}

run_setup_with_progress() {
    local log_file progress_file setup_pid setup_status marker marker_type marker_index marker_label child_state
    local current_label="System und Rover prüfen"
    local current_step=0
    local step_started=$SECONDS
    local now elapsed eta_factor=150 previous_elapsed observed_factor previous_weight
    local waiting=0 result_kind= result_value=

    log_file=$(mktemp)
    progress_file=$(mktemp)
    chmod 0600 "$log_file" "$progress_file"

    cleanup_progress() {
        kill -TERM "$setup_pid" 2>/dev/null || true
        wait "$setup_pid" 2>/dev/null || true
        if [ -t 1 ]; then
            printf '\r\033[2K\n'
        fi
        rm -f "$log_file" "$progress_file"
        exit 130
    }

    run_setup 3>"$progress_file" >"$log_file" 2>&1 &
    setup_pid=$!
    trap cleanup_progress INT TERM HUP

    while :; do
        child_state=$(ps -o stat= -p "$setup_pid" 2>/dev/null | awk '{print $1}' || true)
        case "$child_state" in
            Z*|'') break ;;
        esac

        marker=$(tail -n 1 "$progress_file" 2>/dev/null || true)
        if [ -n "$marker" ]; then
            IFS='|' read -r marker_type marker_index marker_label <<<"$marker"
            case "$marker_type" in
                STEP)
                    waiting=0
                    if [ "$marker_index" != "$current_step" ]; then
                        now=$SECONDS
                        if [ "$current_step" -gt 0 ]; then
                            previous_elapsed=$((now - step_started))
                            previous_weight=${STEP_WEIGHTS[current_step - 1]}
                            observed_factor=$((previous_elapsed * 100 / previous_weight))
                            eta_factor=$(((eta_factor * 70 + observed_factor * 30) / 100))
                            [ "$eta_factor" -ge 50 ] || eta_factor=50
                            [ "$eta_factor" -le 350 ] || eta_factor=350
                        fi
                        current_step=$marker_index
                        current_label=$marker_label
                        step_started=$SECONDS
                    fi
                    ;;
                WAIT)
                    waiting=1
                    ;;
                RESULT)
                    result_kind=$marker_index
                    result_value=$marker_label
                    ;;
            esac
        fi

        if [ "$waiting" -eq 0 ] && [ "$current_step" -gt 0 ]; then
            now=$SECONDS
            elapsed=$((now - step_started))
            render_progress "$current_step" "$current_label" "$elapsed" "$eta_factor"
        fi
        sleep 0.15
    done

    if wait "$setup_pid"; then
        setup_status=0
    else
        setup_status=$?
    fi
    trap - INT TERM HUP

    if [ -t 1 ]; then
        printf '\r\033[2K\n'
    fi
    if [ "$setup_status" -eq 0 ]; then
        case "$result_kind" in
            REBOOT)
                printf '✓ UART-Konfiguration ergänzt in %s.\n' "$result_value"
                printf 'Bitte jetzt sudo reboot ausführen und danach dasselbe Setup-Kommando erneut starten.\n'
                ;;
            DONE)
                printf '✓ Vorbereitung abgeschlossen.\n'
                printf 'SSH: ssh %s@%s.local\n' "$ROVER_USER" "$result_value"
                printf 'Das Passwort steht auf dem Rover-OLED.\n'
                printf 'Pi und Laptop müssen dasselbe vertrauenswürdige Netzwerk erreichen.\n'
                printf 'Neustart: sudo reboot\n'
                if [ -f /var/run/reboot-required ]; then
                    printf 'Das Betriebssystem meldet zusätzlich, dass ein Neustart erforderlich ist.\n'
                fi
                ;;
            *)
                printf '✓ Setup abgeschlossen.\n'
                ;;
        esac
    else
        printf '✗ Setup abgebrochen bei „%s“. Für die Befehlsausgabe erneut mit --debug starten.\n' "$current_label" >&2
    fi

    rm -f "$log_file" "$progress_file"
    return "$setup_status"
}

if [ "$DEBUG" -eq 1 ]; then
    run_setup
else
    run_setup_with_progress
fi
