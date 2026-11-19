# Rebase meridian2 to Meridian OS (needs Dongwon's OK)

Tested in a VM on meridian2 (Secure Boot, TPM2+PIN with PCR 7+14 like meridian2, no Ledger): boot PIN, wrong PIN,
recovery key, password login, lock screen, run0, apps, Keep Screen On, Ctrl+C/V, Ledger-only lock screen with a test
enrolment, Ctrl+Alt+F3 rescue, `meridian-ledger disable`, rollback. All passed (builds b4f98e4, 43fb1d2, a938ff6, f1982b7).

## Before
- `rpm-ostree status`: note the current image line (secureblue silverblue-nvidia-open-hardened).
- `run0 ostree admin pin 0`: keeps today's secureblue deployment in the boot menu for good (undo: `ostree admin pin -u 0`).
- Have the LUKS recovery key (paper) at hand.

## Commands (two reboots)
1. `run0 rpm-ostree rebase ostree-unverified-registry:ghcr.io/lentyrevamped/meridian-os:latest`, then `systemctl reboot`.
   (Unverified once only because the Meridian signing key is not on the laptop yet; the image brings it.)
2. `run0 rpm-ostree rebase ostree-image-signed:docker://ghcr.io/lentyrevamped/meridian-os:latest`, then `systemctl reboot`.
   From then on every daily update is signature-checked against the Meridian key.

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
