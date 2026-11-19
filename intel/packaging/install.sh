#!/usr/bin/env bash
# Meridian Intel, phase 1 install for ONE user (no root, no layering, nothing system-wide).
#   ./packaging/install.sh            install / update
#   ./packaging/install.sh --remove   uninstall (keeps your data in ~/.local/share/meridian-intel/intel.db)
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/meridian-intel"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
UNITS="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
BIN="$HOME/.local/bin"

if [[ "${1:-}" == "--remove" ]]; then
  systemctl --user disable --now meridian-intel.service 2>/dev/null || true
  rm -rf "$DATA/app" "$DATA/venv" "$BIN/meridian-intel" "$APPS/org.meridian.Intel.desktop" "$UNITS/meridian-intel.service"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "Removed. Data kept in $DATA (delete it yourself if you want the cases and audit log gone)."
  exit 0
fi

command -v python3 >/dev/null || { echo "python3 missing"; exit 1; }
mkdir -p "$DATA" "$APPS" "$UNITS" "$BIN"; chmod 700 "$DATA"
[[ -d "$DATA/venv" ]] || python3 -m venv "$DATA/venv"
"$DATA/venv/bin/pip" install -q --upgrade pip
"$DATA/venv/bin/pip" install -q -r "$SRC/requirements.txt"
rm -rf "$DATA/app"; mkdir -p "$DATA/app"
cp -r "$SRC/meridian_intel" "$SRC/web" "$DATA/app/"
cat > "$BIN/meridian-intel" <<SH
#!/usr/bin/env bash
PYTHONPATH="$DATA/app" exec "$DATA/venv/bin/python" -s -P -m meridian_intel "\$@"
SH
chmod 755 "$BIN/meridian-intel"
sed "s|@BIN@|$BIN|g" "$SRC/packaging/meridian-intel.service" > "$UNITS/meridian-intel.service"
sed "s|@BIN@|$BIN|g; s|@ICON@|$DATA/app/web/mark.svg|g" "$SRC/packaging/org.meridian.Intel.desktop" > "$APPS/org.meridian.Intel.desktop"
systemctl --user daemon-reload
echo "Installed. Open 'Meridian Intel' from the app grid, or run: meridian-intel launch"
echo "Optional keys: meridian-intel keys set aisstream | anthropic | hibp"
