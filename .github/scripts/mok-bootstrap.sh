#!/usr/bin/env bash
# One-time: create the Meridian MOK (Machine Owner Key) that signs Meridian's kernel modules.
# Runs only when kmods/mok/meridian-mok.key.enc does not exist yet. The private key is generated on the CI runner,
# encrypted (PKCS#8, AES-256-CBC, PBKDF2-SHA256 1M rounds) with MERIDIAN_MOK_PASS (derived from the image signing key)
# and committed together with the public certificate. The plain key never leaves the runner's temp dir.
# The certificate carries the "module signing only" EKU (1.3.6.1.4.1.2312.16.1.2): shim refuses it for boot
# binaries, so this key can sign kernel modules but never a bootloader or kernel.
set -euo pipefail
ENC=kmods/mok/meridian-mok.key.enc
DER=files/system/usr/share/meridian/mok/meridian-mok.der
if [ -s "$ENC" ] && [ -s "$DER" ]; then echo "MOK exists: $(openssl x509 -inform DER -in "$DER" -noout -fingerprint -sha256)"; exit 0; fi
: "${MERIDIAN_MOK_PASS:?}"
t=$(mktemp -d "$RUNNER_TEMP/mok.XXXXXX"); chmod 700 "$t"; trap 'shred -u "$t"/* 2>/dev/null || true; rm -rf "$t" || true' EXIT
cat > "$t/x509.cnf" <<'CNF'
[ req ]
distinguished_name = dn
prompt = no
x509_extensions = ext
[ dn ]
O = Meridian
CN = Meridian OS kernel modules
[ ext ]
basicConstraints = critical,CA:FALSE
keyUsage = digitalSignature
extendedKeyUsage = codeSigning,1.3.6.1.4.1.2312.16.1.2
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
CNF
openssl req -x509 -new -nodes -newkey rsa:4096 -sha256 -days 36500 -config "$t/x509.cnf" -keyout "$t/key.pem" -outform DER -out "$t/cert.der"
mkdir -p "$(dirname "$ENC")" "$(dirname "$DER")"
openssl pkcs8 -topk8 -in "$t/key.pem" -v2 aes-256-cbc -v2prf hmacWithSHA256 -iter 1000000 -passout env:MERIDIAN_MOK_PASS -out "$ENC"
cp "$t/cert.der" "$DER"
# Round trip before committing: the encrypted key must decrypt and match the certificate.
openssl pkcs8 -in "$ENC" -passin env:MERIDIAN_MOK_PASS -out "$t/check.pem"
[ "$(openssl pkey -in "$t/check.pem" -pubout)" = "$(openssl x509 -inform DER -in "$DER" -noout -pubkey)" ] || { echo "::error::MOK round trip failed"; exit 1; }
openssl x509 -inform DER -in "$DER" -noout -subject -fingerprint -sha256
git config user.name "github-actions[bot]"; git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add "$ENC" "$DER"
git commit -m "Meridian MOK: module signing certificate and encrypted key (generated in CI)"
for i in 1 2 3 4; do git push origin "HEAD:${GITHUB_REF_NAME}" && break; sleep $((i * 5)); git pull --rebase origin "$GITHUB_REF_NAME"; done
