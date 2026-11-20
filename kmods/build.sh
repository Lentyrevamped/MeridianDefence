#!/usr/bin/env bash
# Build, strip and sign Meridian's out-of-tree kernel modules for the image kernel.
# Runs as root INSIDE the base image (same kernel as the final image), started by kmods/ci-build.sh.
#   /src  this kmods/ directory (read only)
#   /mok  meridian-mok.key + meridian-mok.der (read only, CI runner temp, never part of the image)
#   /out  output tree, copied over files/system/ before the image build
# A module that fails to build is skipped with a warning (the stock in-tree driver stays in use);
# the result of every module is written to /out/usr/share/meridian/kmods/status.
set -uo pipefail
KVER=$(ls /usr/lib/modules | sort -V | tail -1)
KDIR=/usr/src/kernels/$KVER
DEST=/out/usr/lib/modules/$KVER/updates/meridian
STATUS=/out/usr/share/meridian/kmods/status
mkdir -p "$DEST" "$(dirname "$STATUS")"
: > "$STATUS"
st() { echo "$1" >> "$STATUS"; echo "kmods: $1"; }
warn() { echo "::warning::kmods: $1"; }
st "kernel=$KVER"
st "built=$(date -u +%Y-%m-%dT%H:%MZ)"

# Toolchain + headers for exactly this kernel. Fedora repos first, Koji when the repos moved on to a newer build.
dnf -y -q --setopt=install_weak_deps=False install gcc make elfutils-libelf-devel openssl kmod binutils >/dev/null || true
if ! dnf -y -q --setopt=install_weak_deps=False install "kernel-devel-$KVER" >/dev/null 2>&1; then
  V=${KVER%%-*}; R=${KVER#*-}; R=${R%.*}; A=${KVER##*.}
  url="https://kojipkgs.fedoraproject.org/packages/kernel/$V/$R/$A/kernel-devel-$KVER.rpm"
  echo "kmods: kernel-devel-$KVER not in the repos, trying Koji"
  curl -fsSL --retry 4 -o /tmp/kernel-devel.rpm "$url" && dnf -y -q install /tmp/kernel-devel.rpm >/dev/null || true
fi
if [ ! -x "$KDIR/scripts/sign-file" ]; then
  warn "no kernel-devel for $KVER, building no modules (stock drivers stay in use)"; st "result=no-kernel-devel"; exit 0
fi

KEY=/mok/meridian-mok.key; CERT=/mok/meridian-mok.der
intree() { find "/usr/lib/modules/$KVER/kernel" -name "$1.ko*" -print -quit; }

# build <dir> <module...>: compile in a scratch copy, strip, sign, verify signer + vermagic, install.
build() {
  local dir=$1; shift; local w=/tmp/kb/$dir m ok=1
  rm -rf "$w"; mkdir -p "$w"; cp -a "/src/$dir/." "$w/"
  if ! make -s -C "$KDIR" M="$w" KVER="$KVER" modules > "$w/build.log" 2>&1; then
    warn "$dir failed to build against $KVER"; sed 's/^/    /' "$w/build.log" | tail -40; for m in "$@"; do st "$m=build-failed"; done; return
  fi
  for m in "$@"; do
    local ko="$w/$m.ko"
    [ -f "$ko" ] || { warn "$m.ko missing after build"; st "$m=missing"; ok=0; continue; }
    strip --strip-debug "$ko"
    "$KDIR/scripts/sign-file" sha256 "$KEY" "$CERT" "$ko" || { warn "$m: signing failed"; st "$m=sign-failed"; continue; }
    local vm signer
    vm=$(modinfo -F vermagic "$ko" | awk '{print $1}'); signer=$(modinfo -F signer "$ko")
    if [ "$vm" != "$KVER" ]; then warn "$m: vermagic $vm != $KVER"; st "$m=vermagic-mismatch"; continue; fi
    if [ "$signer" != "Meridian OS kernel modules" ]; then warn "$m: unexpected signer '$signer'"; st "$m=bad-signer"; continue; fi
    install -m 0644 "$ko" "$DEST/$m.ko"
    st "$m=ok sha256=$(sha256sum "$DEST/$m.ko" | cut -c1-16)"
  done
}

# Speakers: MAX98390 x4 side codecs (thesofproject/linux PR #5616, out of tree). Skipped once the kernel has its own driver.
if [ -n "$(intree snd-hda-scodec-max98390)" ]; then st "snd-hda-scodec-max98390=native-in-kernel"
else build max98390-hda snd-hda-scodec-max98390 snd-hda-scodec-max98390-i2c; fi

# Camera: OV02C10 with 26 MHz external clock support (overrides the in-tree driver from updates/).
build ov02c10 ov02c10

# Camera: ipu-bridge with the Samsung upside-down sensor quirk (960XGL = Galaxy Book4 Ultra). Only replaceable when it is a module.
if [ -n "$(intree ipu-bridge)" ]; then build ipu-bridge ipu-bridge
else warn "ipu-bridge is built into $KVER, rotation quirk not applied"; st "ipu-bridge=builtin-not-replaceable"; fi

st "signer=$(openssl x509 -inform DER -in "$CERT" -noout -fingerprint -sha256 | cut -d= -f2)"
exit 0
