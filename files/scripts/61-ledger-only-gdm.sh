#!/usr/bin/env bash
# "Ledger only" at GDM and the lock screen also means: no fingerprint or smartcard way around it.
# GDM runs gdm-fingerprint / gdm-smartcard next to gdm-password. For users with a Ledger enrolled, those services
# now fail at once (same gate as gdm-password); everyone else keeps the stock behaviour. sudo/run0, polkit and the
# text console are not touched (a fingerprint set up there keeps working there).
set -uo pipefail
MARK="# Meridian: Ledger-only sign-in (no fingerprint/smartcard bypass for Ledger users)"
DENY="auth       [success=die default=ignore] pam_exec.so quiet /usr/libexec/meridian/ledger-login-enabled"
for svc in gdm-fingerprint gdm-smartcard; do
  F=/etc/pam.d/$svc; [ -f "$F" ] || F=/usr/lib/pam.d/$svc
  [ -f "$F" ] || { echo "ledger-only: no $svc service, nothing to gate"; continue; }
  grep -qF "$MARK" "$F" && { echo "ledger-only: $svc already gated"; continue; }
  awk -v m="$MARK" -v d="$DENY" '!done && /^[[:space:]]*-?auth[[:space:]]/ { print m; print d; done=1 } { print } END { if (!done) exit 3 }' \
    "$F" > "$F.new" && [ "$(grep -E '^[[:space:]]*-?auth[[:space:]]' "$F.new" | head -1)" = "$DENY" ] \
    && { mv "$F.new" "$F"; chmod 0644 "$F"; echo "ledger-only: $svc gated ($F)"; } \
    || { rm -f "$F.new"; echo "WARN ledger-only: could not gate $F"; }
done
exit 0
