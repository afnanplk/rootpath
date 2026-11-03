#!/bin/sh
# Run only inside a disposable Linux VM/VPS. Never invoked by the app or local lab.
set -eu
[ "$(uname -s)" = Linux ] && [ -d /run/systemd/system ] || { echo 'A disposable systemd Linux VM is required.' >&2; exit 1; }
[ "$(id -u)" = 0 ] || { echo 'Run explicitly with sudo in the disposable VM.' >&2; exit 1; }
unit=/etc/systemd/system/vps-explorer-test.service
marker='# Rootpath disposable acceptance service'
case "${1:-}" in
  --install)
    [ ! -e "$unit" ] && [ ! -L "$unit" ] || { echo 'Unit already exists; refusing to overwrite it.' >&2; exit 1; }
    [ -x /usr/bin/sleep ] || { echo '/usr/bin/sleep is required.' >&2; exit 1; }
    (set -C; cat > "$unit" <<'UNIT'
# Rootpath disposable acceptance service
[Unit]
Description=Rootpath disposable acceptance service
[Service]
Type=simple
ExecStart=/usr/bin/sleep infinity
Restart=no
UNIT
    )
    chmod 644 "$unit"
    systemctl daemon-reload
    systemctl start vps-explorer-test.service
    echo 'Test service started. It is not enabled at boot.'
    ;;
  --remove)
    [ -f "$unit" ] && [ ! -L "$unit" ] && grep -qxF "$marker" "$unit" || { echo 'Expected managed test unit not found; refusing removal.' >&2; exit 1; }
    systemctl stop vps-explorer-test.service
    rm -- "$unit"
    systemctl daemon-reload
    echo 'Test service removed.'
    ;;
  *) echo 'Usage: sudo sh linux-test-service.sh --install | --remove' >&2; exit 1 ;;
esac
