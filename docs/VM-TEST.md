# Meridian OS VM test (run on meridian2, VM only)

Image: `ghcr.io/lentyrevamped/meridian-os:latest` (signed; key = `cosign.pub` in github.com/Lentyrevamped/MeridianDefence).

**Rules:** VM only. Do not change meridian2's own deployment and do not layer anything on the host without Dongwon's OK.
If libvirt/qemu/swtpm (e.g. what the ARTEX VM uses) are not available without layering, stop and report.

## Setup
- UEFI with Secure Boot (OVMF secboot), swtpm TPM 2.0, ~40 GB disk, 8 GB RAM, **no Ledger passed through**.
- Install Fedora Silverblue 45 with LUKS (set a passphrase).
- `rpm-ostree rebase ostree-unverified-registry:ghcr.io/lentyrevamped/meridian-os:latest`, reboot,
  then `rpm-ostree rebase ostree-image-signed:docker://ghcr.io/lentyrevamped/meridian-os:latest`, reboot.
- Enrol TPM2+PIN the way meridian2 has it (`systemd-cryptenroll --tpm2-device=auto --tpm2-with-pin=yes` + meridian2's crypttab/dracut option).

## Checks (1-6 with NO Ledger)
1. Boot: Meridian splash + "Enter PIN"; right PIN unlocks; wrong PIN shows "Incorrect PIN", retry works.
2. Fallback: make TPM unlock fail (wipe the TPM slot in a snapshot, or change PCR 7): prompt shows "Enter recovery key", LUKS passphrase unlocks.
3. GDM (nothing enrolled): password login works, no Ledger card. Lock (Super+L) and unlock with the password.
4. pkexec / GNOME Software install and sudo/run0 accept the password.
5. rclone present; `meridian-flatpaks.service` succeeded and the apps are installed; Keep Screen On toggles; dock order right;
   Ptyxis: Ctrl+C with a selection copies, Ctrl+C with no selection still interrupts `sleep 100` (important); Ctrl+V pastes.
6. Ledger-only sign-in, still with NO Ledger. Write a test enrolment (random key, nothing to do with Dongwon's Ledger):
   `run0 python3 -IsB -c 'import sys; sys.path.insert(0,"/usr/lib/meridian/python"); import meridian_login as L; from cryptography.hazmat.primitives.asymmetric import ec; from cryptography.hazmat.primitives import serialization as s; k=ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(s.Encoding.X962, s.PublicFormat.UncompressedPoint); print(L.save_enrollment("USER", 0, k))'`
   (USER = the VM user). `meridian-ledger status` says ON.
   - Lock (Super+L): unlock shows "Connect your Ledger and open the Meridian app", no password field; after ~60 s "No Ledger
     with the Meridian app found". Typing the password does not get in. Same at GDM after logging out.
   - **Ctrl+Alt+F3: password login works.** Then `run0 meridian-ledger disable`, Ctrl+Alt+F1/F2: GDM takes the password again.
   - sudo/run0 and an admin prompt took the password the whole time.
7. Optional, only if the Ledger can be passed through to the VM (USB, Meridian app 1.5): `run0 meridian-ledger enroll`, then lock:
   card with code, matching code on the Ledger, hold = unlocked; Reject = refused; `ausearch -m avc -ts recent` shows no denial for
   ledger-login. Finish with `run0 meridian-ledger disable`. Never use "Register computer" on the Ledger.
8. `rpm-ostree rollback` boots the previous deployment.

## Report
Pass/fail per item, screenshots of 1, 2 and the GDM login, `rpm-ostree status`, and journal errors for anything that fails
(`journalctl -b -u 'plymouth*'`, `journalctl --user -u meridian-flatpaks`, `journalctl -b -t meridian-ledger-login`, `ausearch -m avc -ts boot`).
