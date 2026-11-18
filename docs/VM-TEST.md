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

## Checks (all with NO Ledger)
1. Boot: Meridian splash + "Enter PIN"; right PIN unlocks; wrong PIN shows "Incorrect PIN", retry works.
2. Fallback: make TPM unlock fail (wipe the TPM slot in a snapshot, or change PCR 7): prompt shows "Enter recovery key", LUKS passphrase unlocks.
3. GDM: password login works, no Ledger card. Lock (Super+L) and unlock with the password.
4. pkexec / GNOME Software install and sudo/run0 accept the password.
5. rclone present; `meridian-flatpaks.service` succeeded and the apps are installed; Keep Screen On toggles; dock order right;
   Ptyxis: Ctrl+C with a selection copies, Ctrl+C with no selection still interrupts `sleep 100` (important); Ctrl+V pastes.
6. `rpm-ostree rollback` boots the previous deployment.

## Report
Pass/fail per item, screenshots of 1, 2 and the GDM login, `rpm-ostree status`, and journal errors for anything that fails
(`journalctl -b -u 'plymouth*'`, `journalctl --user -u meridian-flatpaks`).
