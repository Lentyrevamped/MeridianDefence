#!/usr/bin/env bash
# Enable the Meridian shell extensions only when each declares this image's GNOME Shell major version.
# Otherwise it stays installed but off: GDM, the lock screen and the desktop fall back to stock GNOME. The Ledger
# step still works there as plain text (it is driven by PAM, not by the extension).
#   meridian-ledger : Ledger card on the login and lock screens
#   meridian-shell  : corporate styling (purple top bar + SECURED, square navy menus, login/lock cards)
set -uo pipefail
shell=$(rpm -q --qf '%{VERSION}' gnome-shell | cut -d. -f1)
on=()
for UUID in meridian-ledger@meridian-os meridian-shell@meridian-os; do
  D=/usr/share/gnome-shell/extensions/$UUID
  if python3 -c "import json,sys; sys.exit(0 if '$shell' in json.load(open('$D/metadata.json'))['shell-version'] else 1)"; then
    on+=("'$UUID'"); echo "extension: $UUID enabled for GNOME $shell"
  else
    echo "WARN extension: $UUID does not declare GNOME $shell, left disabled (stock UI)"
  fi
done
mkdir -p /etc/dconf/db/gdm.d /etc/dconf/db/local.d
rm -f /etc/dconf/db/gdm.d/20-meridian-ledger /etc/dconf/db/local.d/20-meridian-ledger
if [ ${#on[@]} -gt 0 ]; then
  list=$(IFS=,; echo "${on[*]}")
  printf "[org/gnome/shell]\nenabled-extensions=[%s]\ndisable-user-extensions=false\n" "$list" > /etc/dconf/db/gdm.d/20-meridian-ledger
  printf "[org/gnome/shell]\nenabled-extensions=[%s]\n" "$list" > /etc/dconf/db/local.d/20-meridian-ledger
fi
dconf update 2>/dev/null || true
exit 0
