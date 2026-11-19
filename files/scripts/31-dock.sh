#!/usr/bin/env bash
# Side dock: Dash to Dock (Fedora package), fixed on the left, full height, square navy.
# Desktop session only (never GDM or the lock screen). Fails back to the stock GNOME dash if the package is
# missing or does not declare this image's GNOME version. To move the dock, change POSITION (LEFT/BOTTOM/RIGHT).
set -uo pipefail
POSITION=LEFT
UUID=dash-to-dock@micxgx.gmail.com
D=/usr/share/gnome-shell/extensions/$UUID
shell=$(rpm -q --qf '%{VERSION}' gnome-shell | cut -d. -f1)
rm -f /etc/dconf/db/local.d/21-meridian-dock
if ! rpm -q gnome-shell-extension-dash-to-dock >/dev/null 2>&1; then
  dnf -y install gnome-shell-extension-dash-to-dock || echo "WARN dock: package not available"
fi
if [ ! -f "$D/metadata.json" ] || ! python3 -c "import json,sys; sys.exit(0 if '$shell' in json.load(open('$D/metadata.json'))['shell-version'] else 1)"; then
  echo "WARN dock: Dash to Dock missing or not built for GNOME $shell, stock dash kept"; exit 0
fi
L=/etc/dconf/db/local.d/20-meridian-ledger
if [ -f "$L" ]; then
  sed -i "s/^enabled-extensions=\[\(.*\)\]/enabled-extensions=[\1,'$UUID']/" "$L"
else
  printf "[org/gnome/shell]\nenabled-extensions=['%s']\n" "$UUID" > "$L"
fi
cat > /etc/dconf/db/local.d/21-meridian-dock <<CONF
[org/gnome/shell/extensions/dash-to-dock]
dock-position='$POSITION'
dock-fixed=true
extend-height=true
height-fraction=1.0
autohide=false
intellihide=false
dash-max-icon-size=36
icon-size-fixed=true
apply-custom-theme=false
custom-theme-shrink=true
custom-background-color=true
background-color='#141C25'
transparency-mode='FIXED'
background-opacity=1.0
running-indicator-style='SQUARES'
custom-theme-customize-running-dots=true
custom-theme-running-dots-color='#4C90F0'
custom-theme-running-dots-border-width=0
show-apps-at-top=false
show-trash=false
show-mounts=false
show-show-apps-button=true
disable-overview-on-startup=true
click-action='focus-minimize-or-previews'
scroll-action='do-nothing'
hot-keys=false
multi-monitor=false
CONF
dconf update 2>/dev/null || true
echo "dock: Dash to Dock $(python3 -c "import json;print(json.load(open('$D/metadata.json')).get('version','?'))") enabled, position $POSITION"
exit 0
