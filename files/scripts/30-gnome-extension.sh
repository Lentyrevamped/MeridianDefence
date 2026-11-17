#!/usr/bin/env bash
# Enable the Meridian sign-in extension only when it declares this image's GNOME Shell major version.
# Otherwise it stays installed but off: GDM and the lock screen fall back to stock GNOME, and the Ledger
# step still works there as plain text (it is driven by PAM, not by the extension).
set -uo pipefail
UUID=meridian-ledger@meridian-os
D=/usr/share/gnome-shell/extensions/$UUID
shell=$(rpm -q --qf '%{VERSION}' gnome-shell | cut -d. -f1)
if python3 -c "import json,sys; sys.exit(0 if '$shell' in json.load(open('$D/metadata.json'))['shell-version'] else 1)"; then
  mkdir -p /etc/dconf/db/gdm.d /etc/dconf/db/local.d
  printf "[org/gnome/shell]\nenabled-extensions=['%s']\ndisable-user-extensions=false\n" "$UUID" > /etc/dconf/db/gdm.d/20-meridian-ledger
  printf "[org/gnome/shell]\nenabled-extensions=['%s']\n" "$UUID" > /etc/dconf/db/local.d/20-meridian-ledger
  echo "extension: enabled for GNOME $shell"
else
  echo "WARN extension: does not declare GNOME $shell, left disabled (stock sign-in UI)"
fi
dconf update 2>/dev/null || true
exit 0
