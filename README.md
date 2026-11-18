# Meridian OS

secureblue (hardened Fedora Atomic, GNOME, open NVIDIA) with Meridian branding and Ledger sign-in, for meridian2.
Built and signed daily by GitHub Actions with BlueBuild. Nothing here touches upstream security settings.

Ledger scope: exactly two uses. Disk unlock at boot (TPM PIN on the laptop, then "Unlock disk" on the Ledger: hold + Meridian PIN)
and sign-in (login and lock screen: "Verify identity", hold, no PIN on the Ledger). Admin prompts use the normal password.
Text contract shown by Plymouth and PAM: `Confirm on your Ledger · code XXXX XXXX XXXX` (the 12-hex code the Ledger shows),
`Approved on Ledger`, `Rejected on Ledger`.

## Never locks you out (hard rule)

- This image changes **no PAM config and no LUKS/crypttab/TPM slot**. Login is stock GDM with your password; disk unlock is the
  existing TPM+PIN (or LUKS passphrase / recovery key) prompt, only drawn by the Meridian theme.
- The Ledger screens appear only when the system itself prints "Confirm on your Ledger · code …". Nothing prints that until a
  Ledger is enrolled, so with no Ledger (or none registered) everything works as before.
- When the Ledger pieces are built they stay off until an explicit `enroll`, and the password / TPM+PIN / recovery key keep working.
- Before any rebase of meridian2: VM test of login with password and disk unlock with TPM+PIN, with no Ledger attached.

## Daily driver (meridian2, from the 18 Nov setup record)

| Piece | How | Per user |
|---|---|---|
| rclone | `dnf` module | |
| Google Drive two-way sync | `/usr/bin/meridian-drive` + `meridian-drive-sync.timer` (5 min, globally enabled; does nothing until `meridian-drive setup`), dock entry with right-click actions, default filters `/usr/share/meridian/drive-filters.txt` | Google sign-in in `~/.config/rclone/rclone.conf`; own filters in `~/.config/rclone/meridian-drive-filters.txt` |
| Keep screen on | `/usr/bin/meridian-keepawake` + "Keep Screen On" app (toggle, on, off) | |
| Apps | `meridian-flatpaks.service` installs `/usr/share/meridian/flatpaks.list` per user on login: Brave, Vesktop, Flatseal, Mission Center, Papers, Loupe, Showtime, Text Editor, Calculator, LibreOffice (verified Flathub), Chrome and Spotify (unfiltered Flathub limited by `flathub.filter`). Skips anything installed, never removes. | |
| Brave privacy policy | `/etc/brave/policies/managed/meridian-privacy.json` | |
| Terminal copy/paste on Ctrl+C / Ctrl+V | `org.gnome.Ptyxis.Shortcuts` default | your own shortcuts win |
| Claude window, dock order | `org.meridian.ClaudeWeb.desktop`, `org.gnome.shell favorite-apps` default | your own dock order wins |
| Bluetooth | not in the image: `ujust set-bluetooth-modules on` is machine state in /etc and survives rebases | |
| UGREEN NAS | on hold (no Linux UGREEN client; NAS is remote) | |

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
