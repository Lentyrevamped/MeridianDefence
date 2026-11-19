#!/usr/bin/env bash
# Keep secureblue's container signature policy (default reject, its own keys) and only ADD the Meridian OS key.
# The BlueBuild signing module seeds /etc/containers/policy.json from a generic template when the base has none
# (secureblue keeps its policy in /usr/share/containers), and that template accepts any unsigned docker image.
# Rebuild /etc from secureblue's policy + our entry, and fail the build if the result is weaker than reject.
set -euo pipefail
BASE=/usr/share/containers/policy.json
OUT=/etc/containers/policy.json
python3 - "$BASE" "$OUT" <<'PY'
import json, sys
base, out = sys.argv[1], sys.argv[2]
ours = json.load(open(out))["transports"]["docker"]
mine = {k: v for k, v in ours.items() if k.startswith("ghcr.io/lentyrevamped/meridian-os")}
assert mine, "Meridian OS entry missing from the signing module output"
try:
    pol = json.load(open(base))
    print(f"container-policy: base = {base}")
except FileNotFoundError:
    pol = json.load(open(out)); print("container-policy: no secureblue base policy, keeping module output")
pol.setdefault("transports", {}).setdefault("docker", {})
pol["transports"]["docker"] = {**mine, **{k: v for k, v in pol["transports"]["docker"].items() if k not in mine}}
# Hard checks: default reject, no catch-all accept for registries.
assert pol["default"] == [{"type": "reject"}], f"default is {pol['default']}"
d = pol["transports"]["docker"]
assert all(e.get("type") != "insecureAcceptAnything" for e in d.get("", [])), "docker catch-all accepts anything"
for k, v in mine.items():
    assert v[0]["type"] == "sigstoreSigned" and v[0]["keyPath"] == "/etc/pki/containers/meridian-os.pub", k
json.dump(pol, open(out, "w"), indent=4); open(out, "a").write("\n")
print("container-policy: docker scopes:", ", ".join(sorted(k or "<default>" for k in d)))
PY
test -s /etc/pki/containers/meridian-os.pub
grep -q "use-sigstore-attachments: true" /etc/containers/registries.d/lentyrevamped-meridian-os.yaml
echo "container-policy: OK (secureblue policy kept, Meridian OS key added)"
