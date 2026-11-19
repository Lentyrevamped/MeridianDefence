#!/usr/bin/env bash
# Stable pieces must be present; fragile pieces only warn.
set -euo pipefail
grep -q '^NAME="Meridian OS"' /usr/lib/os-release
test -s /usr/share/icons/hicolor/scalable/apps/meridian-logo-text-dark.svg
test -s /usr/share/backgrounds/meridian/meridian-dark.png
test -s /usr/share/meridian/gtk-4.0/gtk.css
glib-compile-schemas --strict --dry-run /usr/share/glib-2.0/schemas
command -v rclone >/dev/null
test -x /usr/bin/meridian-drive && test -x /usr/bin/meridian-keepawake && test -x /usr/libexec/meridian/flatpak-setup
python3 -c 'import json; json.load(open("/etc/brave/policies/managed/meridian-privacy.json"))'
echo "verify: stable pieces OK"
[ -f /etc/plymouth/plymouthd.conf ] && echo "verify: Meridian boot theme ON" || echo "WARN verify: boot theme OFF (stock)"
[ -f /etc/dconf/db/gdm.d/20-meridian-ledger ] && echo "verify: sign-in extension ON" || echo "WARN verify: sign-in extension OFF (stock)"
python3 -IsB -c 'import sys; sys.path.insert(0,"/usr/lib/meridian/python"); import meridian_login' \
  && echo "verify: Ledger library imports" || echo "WARN verify: Ledger library does not import"
grep -qs 'ledger-login-enabled' /etc/pam.d/gdm-password /usr/lib/pam.d/gdm-password && echo "verify: Ledger sign-in hook ON (inactive until enrolled)" \
  || echo "WARN verify: Ledger sign-in hook OFF (stock password sign-in)"
if grep -qs meridian /{etc,usr/lib}/pam.d/{login,sudo,polkit-1,run0,system-auth,password-auth}; then
  echo "verify: FAIL, a rescue PAM stack was changed"; exit 1
fi
echo "verify: text console, sudo/run0, polkit untouched (password rescue)"
semodule -l 2>/dev/null | grep -q '^meridian_ledger' && echo "verify: SELinux Ledger module ON" || echo "WARN verify: SELinux Ledger module OFF"
for svc in gdm-fingerprint gdm-smartcard; do
  f=/etc/pam.d/$svc; [ -f "$f" ] || f=/usr/lib/pam.d/$svc; [ -f "$f" ] || continue
  if grep -q ledger-login-enabled /etc/pam.d/gdm-password /usr/lib/pam.d/gdm-password 2>/dev/null && ! grep -q ledger-login-enabled "$f"; then
    echo "verify: FAIL, $svc would bypass Ledger-only sign-in"; exit 1
  fi
done
echo "verify: no fingerprint/smartcard bypass at GDM for Ledger users"
