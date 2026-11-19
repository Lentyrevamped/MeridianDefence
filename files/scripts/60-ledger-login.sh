#!/usr/bin/env bash
# Ledger-only sign-in at GDM and the lock screen (both use /etc/pam.d/gdm-password).
# Off until a user is enrolled (/etc/meridian/ledger/<user>.json, root-owned): the gate below skips straight to
# the stock password stack for everyone else. Text consoles (login), sudo/run0 and polkit are NOT touched, so the
# password always works at Ctrl+Alt+F3. On any error this leaves gdm-password stock and only warns.
set -uo pipefail
F=/etc/pam.d/gdm-password
MARK="# Meridian: Ledger-only sign-in"
GATE="auth       [success=ignore default=1] pam_exec.so quiet /usr/libexec/meridian/ledger-login-enabled"
LEDGER="auth       [success=done default=die] pam_exec.so quiet stdout /usr/libexec/meridian/ledger-login"

chmod 0755 /usr/bin/meridian-ledger /usr/libexec/meridian/ledger-login /usr/libexec/meridian/ledger-login-enabled
install -d -m 0755 -o root -g root /etc/meridian /etc/meridian/ledger

# SELinux: gdm's session worker runs as xdm_t, which may not open USB HID nodes by default.
CIL=/usr/share/selinux/packages/meridian/meridian_ledger.cil
if command -v semodule >/dev/null && semodule -i "$CIL"; then echo "ledger-login: SELinux module installed"
else echo "WARN ledger-login: SELinux module not installed, GDM may be denied the Ledger (text console still works)"; fi

if [ ! -f "$F" ]; then echo "WARN ledger-login: $F missing, Ledger sign-in OFF"; exit 0; fi
if ! python3 -IsB -c 'import sys; sys.path.insert(0,"/usr/lib/meridian/python"); import meridian_login' ; then
  echo "WARN ledger-login: Python library does not import, Ledger sign-in OFF (stock gdm-password)"; exit 0
fi
if grep -qF "$MARK" "$F"; then echo "ledger-login: already present"; exit 0; fi

cp -a "$F" "$F.meridian-orig"
# Insert just before the first auth line, so it runs before the password stack.
awk -v m="$MARK" -v g="$GATE" -v l="$LEDGER" '
  !done && /^[[:space:]]*-?auth[[:space:]]/ { print m; print g; print l; done=1 }
  { print }
  END { if (!done) exit 3 }' "$F.meridian-orig" > "$F.new" || {
  echo "WARN ledger-login: no auth line in $F, left stock"; rm -f "$F.new" "$F.meridian-orig"; exit 0; }

# Check: our two lines are the first two auth lines, and everything else is unchanged.
first2=$(grep -E '^[[:space:]]*-?auth[[:space:]]' "$F.new" | head -2)
rest=$(grep -vxF -e "$MARK" -e "$GATE" -e "$LEDGER" "$F.new")
if [ "$first2" = "$GATE"$'\n'"$LEDGER" ] && [ "$rest" = "$(cat "$F.meridian-orig")" ]; then
  mv "$F.new" "$F"; chmod 0644 "$F"; rm -f "$F.meridian-orig"
  echo "ledger-login: gdm-password patched (active only for enrolled users)"
else
  echo "WARN ledger-login: patch check failed, left stock"; rm -f "$F.new"; mv "$F.meridian-orig" "$F"
fi
sed -n '1,12p' "$F"
exit 0
