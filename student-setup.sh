#!/usr/bin/env bash
set -euo pipefail

ENABLE_I2C=0
ENABLE_SPI=0
ENABLE_VNC=0

usage() {
    cat <<'EOF'
Usage: student-setup.sh [--enable-i2c] [--enable-spi] [--enable-vnc]

Updates Raspberry Pi OS and prepares SSH, Python, Git, and the WAVE ROVER OLED.
It assigns a checked roverXX.local hostname and a short classroom SSH password.
The optional interface flags enable the corresponding Raspberry Pi feature.
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
        --help|-h) usage; exit 0 ;;
        *) die "Unbekannte Option: $1 (siehe --help)" ;;
    esac
    shift
done

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
        exit 0
    fi
fi

[ -e "$SERIAL_DEVICE" ] || die "$SERIAL_DEVICE fehlt. Prüfe die UART-Konfiguration und starte den Rover gegebenenfalls neu."
UART_TTY=$(basename "$(readlink -f "$SERIAL_DEVICE")")
[ -n "$UART_TTY" ] || die "Das serielle Gerät $SERIAL_DEVICE konnte nicht aufgelöst werden."

if { [ "$ENABLE_I2C" -eq 1 ] || [ "$ENABLE_SPI" -eq 1 ] || [ "$ENABLE_VNC" -eq 1 ]; } && ! command -v raspi-config >/dev/null 2>&1; then
    die "Für die angeforderten Interface-Optionen wird raspi-config benötigt."
fi

if [ "${#ROVER_USER}" -gt 15 ]; then
    die "Der Benutzername ist länger als 15 Zeichen und passt nicht vollständig auf das OLED."
fi

SSHD_DROP_IN=/etc/ssh/sshd_config.d/00-wave-rover-student.conf
if [ -e "$SSHD_DROP_IN" ] && ! grep -q '^# Managed by WAVE ROVER student-setup.sh$' "$SSHD_DROP_IN"; then
    die "$SSHD_DROP_IN existiert bereits und wird nicht vom WAVE ROVER Script verwaltet."
fi

printf '\nAktualisiere Raspberry Pi OS. Ein Full-Upgrade enthält bereits normale Paket-Upgrades.\n'
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get full-upgrade -y
DEBIAN_FRONTEND=noninteractive apt-get install -y \
    avahi-daemon avahi-utils git openssh-server python3 python3-pip python3-serial \
    python3-setuptools python3-venv
apt-get autoremove -y

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

TARGET_HOSTNAME="rover$(python3 -c 'import secrets; print(f"{secrets.randbelow(100):02d}")')"
hostnamectl set-hostname "$TARGET_HOSTNAME"
systemctl enable --now avahi-daemon
systemctl restart avahi-daemon

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

printf '\nNeues SSH-Passwort für %s eingeben; Enter erzeugt ein zufälliges vierstelliges Passwort.\n' "$ROVER_USER"
read -r -s -p 'Neues Passwort: ' NEW_PASSWORD </dev/tty
printf '\n' >/dev/tty
if [ -z "$NEW_PASSWORD" ]; then
    NEW_PASSWORD=$(python3 -c 'import secrets; alphabet="abcdefghjkmnpqrstuvwxyz23456789"; print("".join(secrets.choice(alphabet) for _ in range(4)))')
    printf 'Ein zufälliges SSH-Passwort wurde erzeugt und wird auf dem OLED angezeigt.\n'
else
    if [[ ! "$NEW_PASSWORD" =~ ^[abcdefghjkmnpqrstuvwxyz23456789]{4}$ ]]; then
        die "Das Passwort muss genau vier Kleinbuchstaben oder Ziffern enthalten; i, l, o, 0 und 1 sind ausgeschlossen."
    fi
    read -r -s -p 'Neues Passwort wiederholen: ' PASSWORD_CONFIRM </dev/tty
    printf '\n' >/dev/tty
    [ "$NEW_PASSWORD" = "$PASSWORD_CONFIRM" ] || die "Die Passwörter stimmen nicht überein."
    unset PASSWORD_CONFIRM
fi

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
import json
import ipaddress
import subprocess
import time
from pathlib import Path

import serial


def current_ipv4():
    result = subprocess.run(
        ["ip", "-o", "-4", "addr", "show", "up", "scope", "global"],
        text=True,
        capture_output=True,
        check=False,
    )
    addresses = []
    for line in result.stdout.splitlines():
        fields = line.split()
        if "inet" in fields:
            value = fields[fields.index("inet") + 1].split("/", 1)[0]
            address = ipaddress.ip_address(value)
            if not address.is_link_local:
                addresses.append(str(address))

    route = subprocess.run(
        ["ip", "-4", "route", "show", "default"], text=True, capture_output=True, check=False
    )
    for line in route.stdout.splitlines():
        fields = line.split()
        if "dev" not in fields:
            continue
        interface = fields[fields.index("dev") + 1]
        for address_line in result.stdout.splitlines():
            address_fields = address_line.split()
            if len(address_fields) > 3 and address_fields[1].split("@")[0] == interface and "inet" in address_fields:
                value = address_fields[address_fields.index("inet") + 1].split("/", 1)[0]
                address = ipaddress.ip_address(value)
                if not address.is_link_local:
                    return str(address)
    return addresses[0] if addresses else "offline"


credentials = json.loads(Path("/etc/wave-rover-student/credentials.json").read_text(encoding="utf-8"))
ip_address = "offline"
for attempt in range(15):
    ip_address = current_ipv4()
    if ip_address != "offline":
        break
    time.sleep(1)

lines = [
    f"{credentials['hostname']}.local",
    ip_address,
    f"User: {credentials['username']}",
    f"password: {credentials['password']}",
]
last_error = None
for attempt in range(30):
    try:
        with serial.Serial(
            credentials["serial_device"],
            baudrate=credentials["baudrate"],
            timeout=0.2,
            write_timeout=2,
            exclusive=True,
        ) as port:
            for line_number, text in enumerate(lines):
                command = {"T": 3, "lineNum": line_number, "Text": text}
                port.write((json.dumps(command, separators=(",", ":")) + "\n").encode("utf-8"))
                port.flush()
                time.sleep(0.1)
        break
    except (serial.SerialException, OSError) as error:
        last_error = error
        time.sleep(1)
else:
    raise SystemExit(f"OLED could not be updated over {credentials['serial_device']}: {last_error}")
PY
chmod 0755 /usr/local/libexec/wave-rover-student-oled.py

cat >/etc/systemd/system/wave-rover-student-oled.service <<'EOF'
[Unit]
Description=Show WAVE ROVER SSH connection details on the OLED
Wants=network-online.target wave-rover-student-hostname.service
After=network-online.target systemd-udev-settle.service wave-rover-student-hostname.service
ConditionPathExists=/etc/wave-rover-student/credentials.json

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /usr/local/libexec/wave-rover-student-oled.py

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
Wants=wave-rover-student-oled.service
After=wave-rover-student-oled.service
EOF

systemctl daemon-reload
systemctl enable wave-rover-student-hostname.service
systemctl start wave-rover-student-hostname.service
TARGET_HOSTNAME=$(python3 -c 'import json; print(json.load(open("/etc/wave-rover-student/credentials.json"))["hostname"])')
systemctl enable wave-rover-student-oled.service
systemctl start wave-rover-student-oled.service

# Finish all setup that can fail over SSH before changing the login password.
# That way a remote terminal disconnect cannot leave the Pi half configured.
printf '%s:%s\n' "$ROVER_USER" "$NEW_PASSWORD" | chpasswd --crypt-method YESCRYPT
unset NEW_PASSWORD

printf '\nVorbereitung abgeschlossen.\n'
printf 'SSH: ssh %s@%s.local\n' "$ROVER_USER" "$TARGET_HOSTNAME"
printf 'Das Passwort steht auf dem Rover-OLED.\n'
printf 'Verbinde Pi und Laptop mit demselben vertrauenswürdigen Netzwerk.\n'
printf 'Starte den Rover neu, damit alle Updates und UART-Einstellungen sicher aktiv sind: sudo reboot\n'
if [ -f /var/run/reboot-required ]; then
    printf 'Das Betriebssystem meldet zusätzlich, dass ein Neustart erforderlich ist.\n'
fi
