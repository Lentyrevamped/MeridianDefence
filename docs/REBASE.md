# Rebase meridian2 to Meridian OS (needs Dongwon's OK)

Tested in a VM on meridian2 (Secure Boot, TPM2+PIN with PCR 7+14 like meridian2, no Ledger): boot PIN, wrong PIN,
recovery key, password login, lock screen, run0, apps, Keep Screen On, Ctrl+C/V, Ledger-only lock screen with a test
enrolment, Ctrl+Alt+F3 rescue, `meridian-ledger disable`, rollback. All passed (builds b4f98e4, 43fb1d2, a938ff6, f1982b7).

## Before
- Image must be e5ca8ca or newer (keeps secureblue's container policy, default reject; older builds shipped a weaker template).
- `rpm-ostree status`: note the booted (●) secureblue image and any LayeredPackages. If a failed attempt left a pending
  deployment: `run0 rpm-ostree cleanup -p`.
- Pin the booted secureblue deployment so it stays in the boot menu: `run0 sh -c 'ostree admin pin <index of ●>'`
  (0 normally, 1 if something is staged at 0). Undo later with `ostree admin pin -u <index>`.
- Have the LUKS recovery key (paper) at hand.

## Host trust (secureblue rejects unknown images, even "unverified" rebases)
Add the Meridian key the same way the image ships it:
- `/etc/pki/containers/meridian-os.pub` = `cosign.pub` from this repo.
- `/etc/containers/registries.d/lentyrevamped-meridian-os.yaml`:
  `docker: {ghcr.io/lentyrevamped/meridian-os: {use-sigstore-attachments: true}}`
- `/etc/containers/policy.json` = copy of `/usr/share/containers/policy.json` plus, under `transports.docker`:
  `"ghcr.io/lentyrevamped/meridian-os": [{"type": "sigstoreSigned", "keyPath": "/etc/pki/containers/meridian-os.pub", "signedIdentity": {"type": "matchRepository"}}]`
  Default stays reject. Check with `python3 -m json.tool /etc/containers/policy.json`.

## Command (one reboot)
`run0 rpm-ostree rebase --uninstall rclone ostree-image-signed:docker://ghcr.io/lentyrevamped/meridian-os:latest`, then
`systemctl reboot`. (`--uninstall rclone`: it was layered on the host and is in the image now.)

## After the first boot
- Hand the three trust files back to the image so daily updates manage them (otherwise ostree keeps the hand-made copies):
  `run0 cp /usr/etc/containers/policy.json /etc/containers/policy.json`,
  `run0 cp /usr/etc/containers/registries.d/lentyrevamped-meridian-os.yaml /etc/containers/registries.d/`,
  `run0 cp /usr/etc/pki/containers/meridian-os.pub /etc/pki/containers/`; then `ostree admin config-diff | grep -E 'containers|pki'`
  should list none of them.
- `meridian-ledger status` = OFF; `systemctl --user status meridian-flatpaks`; old copies from the daily-driver setup
  (`~/.config/systemd/user/meridian-*`, `~/.local/bin/meridian-*`) can go once the image's versions work.

## What changes
- Boot: Meridian splash and PIN screen. Same TPM PIN; recovery key prompt still there. No TPM/LUKS change at all.
- Login: unchanged. Password at GDM and lock screen, because no Ledger is enrolled. Ledger-only sign-in starts only
  after `run0 meridian-ledger enroll`, and the password always keeps working at Ctrl+Alt+F3, run0 and admin prompts.
- Look: Meridian logo on GDM, Meridian wallpaper, dark + slate accent, tighter corners, "Meridian OS" in About and boot menu.
  Settings you already changed yourself stay yours (dock included: `dconf reset /org/gnome/shell/favorite-apps` for the Meridian dock).
- Apps: on first login a background job installs any of the 12 daily apps that are missing (can take ~10 min); installed apps stay.
- Drive sync timer, Keep Screen On toggle, Ptyxis Ctrl+C/V, Brave privacy policy.
- Still secureblue underneath (same kernel, same hardening, ID=secureblue).

## Roll back
- Any boot: pick the previous entry in the boot menu.
- `run0 rpm-ostree rollback` then reboot.
- Fully back to secureblue: `run0 rpm-ostree rebase ostree-image-signed:docker://ghcr.io/secureblue/silverblue-nvidia-open-hardened:latest`.
