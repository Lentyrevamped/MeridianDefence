#!/usr/bin/env bash
# Signed out-of-tree drivers for meridian2 (Galaxy Book4 Ultra): speakers (MAX98390 x4) and camera (OV02C10 26 MHz,
# ipu-bridge rotation). The modules were built for this kernel and signed with the Meridian MOK before the image build
# (kmods/, .github/scripts/kmods.sh). They load only once the Meridian MOK is enrolled; until then the kernel refuses
# them and the stock in-tree drivers stay in use. Runs before 20-plymouth so the initramfs is built after depmod.
set -uo pipefail
KVER=$(ls /usr/lib/modules | sort -V | tail -1)
D=/usr/lib/modules/$KVER/updates/meridian
CERT=/usr/share/meridian/mok/meridian-mok.der

# Modules staged for another kernel (base image moved on between the module build and this build): drop them.
for d in /usr/lib/modules/*/updates/meridian; do
  [ -d "$d" ] && [ "$d" != "$D" ] || continue
  k=${d#/usr/lib/modules/}; k=${k%%/*}
  echo "WARN kmods: modules were built for $k, image kernel is $KVER; removing them (stock drivers this build)"
  rm -rf "$d"; [ -e "/usr/lib/modules/$k/vmlinuz" ] || rm -rf "/usr/lib/modules/$k"
done

if ls "$D"/*.ko >/dev/null 2>&1; then
  for ko in "$D"/*.ko; do
    echo "kmods: $(basename "$ko") vermagic=$(modinfo -F vermagic "$ko" | awk '{print $1}') signer=$(modinfo -F signer "$ko")"
  done
  depmod -a "$KVER"
  for m in snd-hda-scodec-max98390 ov02c10 ipu-bridge; do
    p=$(modinfo -k "$KVER" -F filename "$m" 2>/dev/null)
    case "${p#/usr}" in "${D#/usr}"/*) echo "kmods: $m resolves to Meridian build";; "") ;; *) echo "WARN kmods: $m resolves to $p";; esac
  done
else
  echo "WARN kmods: no Meridian modules in this build (stock speaker/camera drivers)"
fi

# Speakers: autoload the side-codec driver and create amps 2-4 at boot (the service skips itself if the module is absent).
if [ -f "$D/snd-hda-scodec-max98390-i2c.ko" ]; then
  printf '# Meridian OS speakers (MAX98390 x4)\nsnd-hda-scodec-max98390\nsnd-hda-scodec-max98390-i2c\ni2c-dev\n' > /usr/lib/modules-load.d/meridian-speakers.conf
fi
systemctl enable meridian-speakers.service

# Camera userspace: OV02C10 tuning for libcamera's Simple pipeline (colour correction needs libcamera 0.5+).
lcv=$(rpm -q --qf '%{VERSION}' libcamera 2>/dev/null || echo none)
echo "kmods: libcamera $lcv, pipewire-plugin-libcamera $(rpm -q --qf '%{VERSION}' pipewire-plugin-libcamera 2>/dev/null || echo none)"
if [ "$lcv" != none ] && [ "$(printf '%s\n0.5.0\n' "$lcv" | sort -V | head -1)" = 0.5.0 ]; then
  install -D -m 0644 /usr/share/meridian/camera/ov02c10.yaml /usr/share/libcamera/ipa/simple/ov02c10.yaml
else
  echo "WARN kmods: libcamera $lcv too old for the OV02C10 tuning file, using libcamera's default"
fi
# libcamera's GPU debayer breaks on NVIDIA's EGL (black frames). The camera runs inside PipeWire/WirePlumber, so pin
# only those two user services to Mesa's EGL (the Intel iGPU); everything else keeps NVIDIA offload.
mesa=$(grep -l '"libEGL_mesa' /usr/share/glvnd/egl_vendor.d/*.json 2>/dev/null | head -1)
if [ -n "$mesa" ]; then
  for u in pipewire wireplumber; do
    mkdir -p "/usr/lib/systemd/user/$u.service.d"
    printf '# Meridian OS camera: libcamera debayer on the Intel iGPU (Mesa EGL), not NVIDIA\n[Service]\nEnvironment=__EGL_VENDOR_LIBRARY_FILENAMES=%s\n' "$mesa" > "/usr/lib/systemd/user/$u.service.d/50-meridian-camera.conf"
  done
  echo "kmods: camera EGL pinned to $mesa"
else
  echo "WARN kmods: Mesa EGL vendor file not found, camera EGL not pinned"
fi

[ -s "$CERT" ] && echo "kmods: MOK $(openssl x509 -inform DER -in "$CERT" -noout -fingerprint -sha256 2>/dev/null)"
exit 0
