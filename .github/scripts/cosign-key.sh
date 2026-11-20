#!/usr/bin/env bash
# A key pasted into the GitHub secrets form can pick up CRLF line endings or stray spaces, which cosign rejects
# ("invalid pem block"). Normalise RAW_KEY, mask every line, report only its shape (never its content), and export
# it as MERIDIAN_COSIGN_KEY. Also derives MERIDIAN_MOK_PASS, the passphrase of the encrypted Meridian MOK key
# (kmods/mok/meridian-mok.key.enc): only someone holding the image signing key can decrypt the module signing key.
set -euo pipefail
key=$(printf '%s\n' "$RAW_KEY" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e '/^$/d')
while IFS= read -r line; do [ -n "$line" ] && echo "::add-mask::$line"; done <<<"$key"
raw_cr=$(printf '%s' "$RAW_KEY" | tr -cd '\r' | wc -c)
echo "signing key: $(printf '%s\n' "$key" | wc -l) lines, CR removed: $raw_cr, header: $(printf '%s\n' "$key" | head -1 | grep -o 'BEGIN [A-Z ]*' || echo none)"
printf '%s\n' "$key" | head -1 | grep -q -- '-----BEGIN ENCRYPTED .* PRIVATE KEY-----' || { echo "::error::SIGNING_SECRET is not a cosign private key"; exit 1; }
pass=$(printf 'meridian-mok-v1\n%s\n' "$key" | sha256sum | cut -d' ' -f1)
echo "::add-mask::$pass"
{ echo 'MERIDIAN_COSIGN_KEY<<MERIDIAN_EOF'; printf '%s\n' "$key"; echo 'MERIDIAN_EOF'; echo "MERIDIAN_MOK_PASS=$pass"; } >> "$GITHUB_ENV"
