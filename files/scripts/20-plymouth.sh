#!/usr/bin/env bash
# Install the Meridian Plymouth theme and rebuild the initramfs. If anything fails, keep the stock theme (fail safe).
set -uo pipefail
T=/usr/share/plymouth/themes/meridian
need="meridian.plymouth meridian.script mark24.png mark42.png title-pin.png title-key.png field.png field-err.png dot.png err-pin.png err-key.png foot-pin.png foot-key.png wordmark.png track.png seg.png"
# Flat #0E0E0F background (Graphite design): no wallpaper in the initramfs.
rm -f "$T/ground.png"
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
