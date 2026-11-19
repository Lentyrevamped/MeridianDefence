#!/usr/bin/env bash
# Rename the OS for people (NAME/PRETTY_NAME/LOGO) but keep ID/ID_LIKE/VERSION_ID so secureblue tooling keeps working.
set -euo pipefail
f=/usr/lib/os-release
ver=$(. $f; echo "${VERSION_ID%%.*}")
sed -i -E \
  -e "s|^NAME=.*|NAME=\"Meridian OS\"|" \
  -e "s|^PRETTY_NAME=.*|PRETTY_NAME=\"Meridian OS ${ver}\"|" \
  -e "s|^LOGO=.*|LOGO=meridian-logo|" \
  -e "s|^DEFAULT_HOSTNAME=.*|DEFAULT_HOSTNAME=\"meridian\"|" "$f"
grep -q '^LOGO=' "$f" || echo 'LOGO=meridian-logo' >> "$f"
sed -i "/^VARIANT=/d" "$f"   # no tagline anywhere (Dongwon 19 Nov)
echo "MERIDIAN_IMAGE_BUILT=\"$(date -u +%Y-%m-%dT%H:%MZ)\"" >> "$f"
gtk-update-icon-cache -f /usr/share/icons/hicolor 2>/dev/null || true
cat "$f"
