#!/usr/bin/env bash
# Stable pieces must be present; fragile pieces only warn.
set -euo pipefail
grep -q '^NAME="Meridian OS"' /usr/lib/os-release
test -s /usr/share/icons/hicolor/scalable/apps/meridian-logo-text-dark.svg
test -s /usr/share/backgrounds/meridian/meridian-dark.png
test -s /usr/share/meridian/gtk-4.0/gtk.css
glib-compile-schemas --strict --dry-run /usr/share/glib-2.0/schemas
echo "verify: stable pieces OK"
[ -f /etc/plymouth/plymouthd.conf ] && echo "verify: Meridian boot theme ON" || echo "WARN verify: boot theme OFF (stock)"
[ -f /etc/dconf/db/gdm.d/20-meridian-ledger ] && echo "verify: sign-in extension ON" || echo "WARN verify: sign-in extension OFF (stock)"
