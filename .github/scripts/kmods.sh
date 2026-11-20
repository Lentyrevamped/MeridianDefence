#!/usr/bin/env bash
# Build Meridian's signed kernel modules inside the base image and stage them under files/system/ for the image build.
# Without the MOK (pull requests, or before the one-time setup) the image is built without them: stock drivers stay.
set -euo pipefail
ENC=kmods/mok/meridian-mok.key.enc
DER=files/system/usr/share/meridian/mok/meridian-mok.der
BASE=ghcr.io/secureblue/silverblue-nvidia-open-hardened:latest
if [ ! -s "$ENC" ] || [ ! -s "$DER" ] || [ -z "${MERIDIAN_MOK_PASS:-}" ]; then
  echo "::warning::kmods: no Meridian MOK available, image built without the speaker/camera modules"; exit 0
fi
t=$(mktemp -d "$RUNNER_TEMP/mok.XXXXXX"); chmod 700 "$t"; out=$(mktemp -d "$RUNNER_TEMP/kout.XXXXXX")
trap 'shred -fu "$t"/meridian-mok.key 2>/dev/null || true; rm -rf "$t" 2>/dev/null || true' EXIT
openssl pkcs8 -in "$ENC" -passin env:MERIDIAN_MOK_PASS -out "$t/meridian-mok.key"
[ "$(openssl pkey -in "$t/meridian-mok.key" -pubout)" = "$(openssl x509 -inform DER -in "$DER" -noout -pubkey)" ] || { echo "::error::MOK key does not match its certificate"; exit 1; }
cp "$DER" "$t/meridian-mok.der"; chmod 0444 "$t"/*
docker pull -q "$BASE"
echo "base image: $(docker image inspect --format '{{index .RepoDigests 0}}' "$BASE")"
docker run --rm --network host -v "$PWD/kmods:/src:ro" -v "$t:/mok:ro" -v "$out:/out" "$BASE" bash /src/build.sh
shred -fu "$t/meridian-mok.key"
docker rmi -f "$BASE" >/dev/null 2>&1 || true
sudo chown -R "$(id -u):$(id -g)" "$out"
cp -a "$out/." files/system/
{ echo "### Meridian kernel modules"; echo '```'; cat "$out/usr/share/meridian/kmods/status"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
find files/system/usr/lib/modules -name '*.ko' -printf '%P %s bytes\n' 2>/dev/null || true
exit 0
