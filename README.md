# Meridian OS

secureblue (hardened Fedora Atomic, GNOME, open NVIDIA) with Meridian branding and Ledger sign-in, for meridian2.
Built and signed daily by GitHub Actions with BlueBuild. Nothing here touches upstream security settings.

Ledger scope: exactly two uses. Disk unlock at boot (TPM PIN on the laptop, then "Unlock disk" on the Ledger: hold + Meridian PIN)
and sign-in (login and lock screen: "Verify identity", hold, no PIN on the Ledger). Admin prompts use the normal password.
Text contract shown by Plymouth and PAM: `Confirm on your Ledger · code XXXX XXXX XXXX` (the 12-hex code the Ledger shows),
`Approved on Ledger`, `Rejected on Ledger`.

## What it changes, and how safe each piece is against daily upstream updates

| Piece | Hook | Stability | If upstream breaks it |
|---|---|---|---|
| "Meridian OS" name (About page, boot menu) | `/usr/lib/os-release` NAME/PRETTY_NAME/LOGO, ID kept | STABLE | n/a |
| Logos, wallpaper, lock screen, login logo, dark + slate accent | icons + gschema override | STABLE | users can still change them |
| Boot splash, disk PIN screen, Ledger step | Plymouth script theme in the initramfs | STABLE (Plymouth script API is years old) | build keeps the stock theme |
| Tighter corners in apps (incl. Flatpaks) | per-user `gtk.css`, copied only if the user has none | STABLE | GTK ignores unknown rules = stock look |
| Fancy Ledger login / lock screen UI | GNOME Shell extension | FRAGILE | only enabled when it declares the image's GNOME version, else stock UI; Ledger prompt still works as text |
| Shell corners (Quick Settings, menus) | would need a shell theme | FRAGILE, not done | n/a |

## Test, switch, roll back
1. Test in a VM first (secureblue ISO in the VM, then rebase the VM).
2. Switch the real laptop only after the VM passes:
   `rpm-ostree rebase ostree-unverified-registry:ghcr.io/lentyrevamped/meridian-os:latest`, reboot, then
   `rpm-ostree rebase ostree-image-signed:docker://ghcr.io/lentyrevamped/meridian-os:latest` (signed from then on).
3. Roll back any time: pick the previous entry in the boot menu, or `rpm-ostree rollback`.
