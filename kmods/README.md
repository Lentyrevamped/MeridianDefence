# Meridian OS out-of-tree kernel modules

Built for the image kernel on every image build, signed with the Meridian MOK, installed to
`/usr/lib/modules/<kernel>/updates/meridian/` (overrides the in-tree driver of the same name).

| Module | Source | Why |
|---|---|---|
| `snd-hda-scodec-max98390`, `-i2c` | `max98390-hda/` | Speakers: 4x MAX98390 amps (thesofproject/linux PR #5616, not upstream yet) |
| `ov02c10` | `ov02c10/` | Camera: sensor driver with 26 MHz external clock support |
| `ipu-bridge` | `ipu-bridge/` | Camera: Samsung upside-down sensor quirk (DMI 960XGL = Galaxy Book4 Ultra) |

Vendored from [Andycodeman/samsung-galaxy-book-linux-fixes](https://github.com/Andycodeman/samsung-galaxy-book-linux-fixes)
(`speaker-fix/src`, `ov02c10-26mhz-fix`, `webcam-fix-book5/ipu-bridge-fix`), main branch as of 2026-11-20, GPL-2.0 (`LICENSE`).
The speaker array needs `meridian-speakers.service` (creates amps 2-4 over I2C); the camera needs the IVSC chain, libcamera
and the PipeWire libcamera plugin (`files/scripts/15-kmods.sh`, recipe).

## Signing

- `kmods/mok/meridian-mok.key.enc`: the private key, generated once in CI (`.github/scripts/mok-bootstrap.sh`), PKCS#8
  AES-256 encrypted with a passphrase derived from the image signing key (`SIGNING_SECRET`). Rotating that secret means
  a new MOK (delete both files, the next build creates a new pair, re-enrol).
- `files/system/usr/share/meridian/mok/meridian-mok.der`: the public certificate, in the image at
  `/usr/share/meridian/mok/meridian-mok.der`. It has the "module signing only" EKU, so shim never accepts it for boot binaries.
- Until the certificate is enrolled the kernel (signature enforcement on) refuses these modules and the stock drivers stay.

## Enrolling on a machine (once)

1. `sudo mokutil --import /usr/share/meridian/mok/meridian-mok.der` (set a one-time password), reboot.
2. In the blue MokManager screen: Enroll MOK, Continue, Yes, the password, Reboot.
3. MOK enrolment changes TPM PCR 14, so the disk asks for the recovery key once; then re-seal TPM+PIN.
4. Check: `mokutil --test-key /usr/share/meridian/mok/meridian-mok.der`, `cat /usr/share/meridian/kmods/status`,
   `modinfo -F filename ov02c10`, `systemctl status meridian-speakers`, `cam -l`.
