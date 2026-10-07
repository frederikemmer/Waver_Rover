#!/usr/bin/env bash
set -euo pipefail

INSTALL_ROOT=/opt/wave-rover-control
REPO_URL=
SOURCE_DIR=
ROVER_USER=pi
WORK_DIR=
ROVER_MODEL=$(tr -d '\0' </proc/device-tree/model 2>/dev/null || true)
DEFAULT_SERIAL_DEVICE=/dev/serial0
PI5_UART_OVERLAY_ADDED=0

case "$ROVER_MODEL" in
    *"Raspberry Pi 5"*) DEFAULT_SERIAL_DEVICE=/dev/ttyAMA0 ;;
esac

if printenv SUDO_USER >/dev/null 2>&1; then
    ROVER_USER=$(printenv SUDO_USER)
fi

while [ "$#" -gt 0 ]; do
    case "$1" in
        --repo)
            REPO_URL=$2
            shift 2
            ;;
        --source)
            SOURCE_DIR=$2
            shift 2
            ;;
        --user)
            ROVER_USER=$2
            shift 2
            ;;
        *)
            echo "Unknown option: $1" >&2
            echo "Usage: install.sh [--source PATH | --repo URL] [--user USER]" >&2
            exit 2
            ;;
    esac
done

if [ "$(id -u)" -ne 0 ]; then
    echo "Run this installer with sudo." >&2
    exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
    echo "This installer currently supports Raspberry Pi OS and Debian." >&2
    exit 1
fi

if [ -z "$SOURCE_DIR" ] && [ -z "$REPO_URL" ]; then
    SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
    if [ -d "$SCRIPT_DIR/wave_rover" ]; then
        SOURCE_DIR=$SCRIPT_DIR
    else
        echo "When streamed from curl, pass --repo URL." >&2
        exit 2
    fi
fi

if [ -z "$ROVER_USER" ] || ! id "$ROVER_USER" >/dev/null 2>&1; then
    echo "The rover service user does not exist: $ROVER_USER" >&2
    exit 1
fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg git python3-opencv python3-serial python3-venv

if [ -n "$REPO_URL" ]; then
    WORK_DIR=$(mktemp -d)
    trap 'if [ -n "$WORK_DIR" ]; then rm -rf "$WORK_DIR"; fi' EXIT
    git clone --depth 1 "$REPO_URL" "$WORK_DIR/source"
    SOURCE_DIR=$WORK_DIR/source
fi

if [ ! -d "$SOURCE_DIR/wave_rover" ] || [ ! -f "$SOURCE_DIR/systemd/wave-rover-control@.service" ]; then
    echo "The source directory does not contain the WAVE ROVER application." >&2
    exit 1
fi

install -d "$INSTALL_ROOT"
tar -C "$SOURCE_DIR" --exclude=.git --exclude=.local --exclude=.venv --exclude=__pycache__ -cf - . |
    tar -C "$INSTALL_ROOT" -xf -

python3 -m venv --system-site-packages "$INSTALL_ROOT/.venv"
runuser -u "$ROVER_USER" -- "$INSTALL_ROOT/.venv/bin/python" -c "import cv2, numpy, serial"

install -m 0644 "$INSTALL_ROOT/systemd/wave-rover-control@.service" \
    /etc/systemd/system/wave-rover-control@.service

if [ "$DEFAULT_SERIAL_DEVICE" = /dev/ttyAMA0 ]; then
    BOOT_CONFIG=/boot/firmware/config.txt
    if [ -f "$BOOT_CONFIG" ] && ! grep -Eq '^[[:space:]]*dtoverlay[[:space:]]*=[[:space:]]*uart0-pi5([,[:space:]]|$)' "$BOOT_CONFIG"; then
        cat >>"$BOOT_CONFIG" <<'EOF'

# WAVE ROVER: expose GPIO14/15 as UART0 on the Raspberry Pi 5 header.
[pi5]
dtoverlay=uart0-pi5
[all]
EOF
        PI5_UART_OVERLAY_ADDED=1
    fi
fi

if [ ! -f /etc/default/wave-rover-control ]; then
    cat > /etc/default/wave-rover-control <<EOF
WAVER_HOST=0.0.0.0
WAVER_PORT=8080
WAVER_SERIAL_DEVICE=$DEFAULT_SERIAL_DEVICE
WAVER_BAUD=115200
WAVER_MAX_SPEED=0.5
WAVER_WATCHDOG_MS=450
WAVER_CAMERA_DEVICE=/dev/video0
WAVER_CAMERA_WIDTH=640
WAVER_CAMERA_HEIGHT=480
WAVER_CAMERA_FPS=15
EOF
elif [ "$DEFAULT_SERIAL_DEVICE" = /dev/ttyAMA0 ] && grep -q '^WAVER_SERIAL_DEVICE=/dev/serial0$' /etc/default/wave-rover-control; then
    sed -i 's|^WAVER_SERIAL_DEVICE=/dev/serial0$|WAVER_SERIAL_DEVICE=/dev/ttyAMA0|' /etc/default/wave-rover-control
fi

# The previous bundled default capped the Wave Rover at 70% of its documented
# motor PWM range. Move only that unchanged default to the full 0.5 protocol
# range; preserve any explicit local speed cap.
if [ -f /etc/default/wave-rover-control ] && grep -qx 'WAVER_MAX_SPEED=0.35' /etc/default/wave-rover-control; then
    sed -i 's|^WAVER_MAX_SPEED=0.35$|WAVER_MAX_SPEED=0.5|' /etc/default/wave-rover-control
fi

systemctl daemon-reload
BOOT_CMDLINE=/boot/firmware/cmdline.txt
if [ -f "$BOOT_CMDLINE" ]; then
    sed -i -E 's/(^| )console=(serial0|ttyAMA[0-9]+|ttyS[0-9]+),[0-9]+ / /g' "$BOOT_CMDLINE"
fi

CONSOLE_UART_TTY=$(basename "$(readlink -f /dev/serial0 2>/dev/null || true)")
for UART_TTY in "$CONSOLE_UART_TTY"; do
    if [ -n "$UART_TTY" ]; then
        systemctl mask --now "serial-getty@$UART_TTY.service"
        if [ -e "/sys/class/tty/$UART_TTY" ]; then
            udevadm trigger --action=add "/sys/class/tty/$UART_TTY"
        fi
    fi
done

if [ "$DEFAULT_SERIAL_DEVICE" = /dev/ttyAMA0 ]; then
    systemctl mask --now serial-getty@ttyAMA0.service
    if [ -e /sys/class/tty/ttyAMA0 ]; then
        udevadm trigger --action=add /sys/class/tty/ttyAMA0
    fi
fi
udevadm settle

usermod -aG dialout "$ROVER_USER"

SERVICE_UNIT="wave-rover-control@$ROVER_USER.service"
systemctl enable "$SERVICE_UNIT"
if systemctl is-active --quiet "$SERVICE_UNIT"; then
    systemctl restart "$SERVICE_UNIT"
else
    systemctl start "$SERVICE_UNIT"
fi

ROVER_IP=$(hostname -I | awk '{print $1}')
echo "WAVE ROVER control is ready on port 8080."
if [ -n "$ROVER_IP" ]; then
    echo "Open http://$ROVER_IP:8080 from a device on the same network."
fi
if [ "$PI5_UART_OVERLAY_ADDED" -eq 1 ]; then
    echo "The Raspberry Pi 5 GPIO UART overlay was added. Reboot once to activate /dev/ttyAMA0."
    echo "Run: sudo reboot"
fi
