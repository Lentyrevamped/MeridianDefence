#!/usr/bin/env bash
# Install the Meridian Plymouth theme and rebuild the initramfs. If anything fails, keep the stock theme (fail safe).
set -uo pipefail
T=/usr/share/plymouth/themes/meridian
need="meridian.plymouth meridian.script star.png wordmark.png field.png field-error.png t-enter.png t-pass.png white.png ph.png ph-key.png t-incorrect.png t-incorrect-key.png t-errhint.png t-errhint-key.png"
# Same background as the login screen (one file in the image, copied so it lands in the initramfs).
cp /usr/share/backgrounds/meridian/meridian-ground.png "$T/ground.png" || echo "WARN plymouth: no ground image, flat background"
ok=1; for n in $need; do [ -s "$T/$n" ] || { echo "WARN missing $T/$n"; ok=0; }; done
rpm -q plymouth-plugin-script >/dev/null 2>&1 || dnf -y install plymouth-plugin-script || ok=0
if [ "$ok" = 1 ]; then
  mkdir -p /etc/plymouth
  printf '[Daemon]\nTheme=meridian\nShowDelay=0\nDeviceScale=1\n' > /etc/plymouth/plymouthd.conf
  echo "plymouth: theme meridian"
else
  echo "WARN plymouth: Meridian theme incomplete, keeping the stock theme"
  rm -f /etc/plymouth/plymouthd.conf
fi
# Rebuild the initramfs with the image's own dracut config (same as upstream, plus the theme).
KVER=$(ls /usr/lib/modules | sort -V | tail -1)
if dracut --no-hostonly --kver "$KVER" --reproducible --zstd --add ostree -f "/tmp/initramfs-$KVER.img"; then
  mv "/tmp/initramfs-$KVER.img" "/usr/lib/modules/$KVER/initramfs.img"; chmod 0600 "/usr/lib/modules/$KVER/initramfs.img"
  # Listing goes to a file first: "lsinitrd | grep -q" + pipefail reports a false miss when grep exits early (SIGPIPE).
  lsinitrd "/usr/lib/modules/$KVER/initramfs.img" > /tmp/lsinitrd.txt 2>/dev/null || true
  if grep -q "plymouth/themes/meridian/meridian.script" /tmp/lsinitrd.txt; then echo "initramfs: theme included"
  else echo "WARN initramfs: theme not found inside (stock splash will show)"; grep -E "plymouth" /tmp/lsinitrd.txt | head -20; fi
  rm -f /tmp/lsinitrd.txt
else
  echo "WARN dracut failed, keeping upstream initramfs (stock splash)"; rm -f /etc/plymouth/plymouthd.conf
fi
exit 0
