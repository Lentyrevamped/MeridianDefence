# Meridian OS

secureblue (hardened Fedora Atomic, GNOME, open NVIDIA) with Meridian branding and Ledger sign-in, for meridian2.
Built and signed daily by GitHub Actions with BlueBuild. Nothing here touches upstream security settings.

Ledger scope (19 Nov): sign-in only. Once you enrol, GDM and the lock screen accept ONLY the Ledger (Meridian app,
"Verify identity", hold, no PIN on the Ledger). Disk unlock stays stock TPM+PIN with the recovery key; the Meridian theme only draws it.
Text contract shown by PAM: `Confirm on your Ledger · code XXXX XXXX XXXX` (the 12-hex code the Ledger shows),
`Approved on Ledger`, `Rejected on Ledger`.

## Never locks you out (hard rule)

- No LUKS/crypttab/TPM change at all. Disk unlock is the existing TPM+PIN (or recovery key) prompt.
- Ledger sign-in is **off until `run0 meridian-ledger enroll`**. Without an enrolment file the GDM stack goes straight to the
  stock password, so installing the image changes nothing about logging in.
- Only `/etc/pam.d/gdm-password` (GDM + lock screen) gets the Ledger step. Text consoles (`login`), sudo/run0 and polkit keep
  the password, and the build fails if any of those is touched.
- Rescue (lost or broken Ledger): **Ctrl+Alt+F3**, log in with your password, `run0 meridian-ledger disable`, back to Ctrl+Alt+F1/F2.
- Any error in the Ledger pieces fails closed at GDM only (message says to use Ctrl+Alt+F3); it never affects the console.
- Before any rebase of meridian2: VM test with no Ledger attached (docs/VM-TEST.md).

## Ledger sign-in

| Command | What it does |
|---|---|
| `meridian-ledger status` | on/off, key fingerprint |
| `run0 meridian-ledger enroll` | approve the key on the Ledger, confirm enrolment, one test sign-in, then GDM is Ledger-only |
| `meridian-ledger test` | one sign-in on the Ledger, changes nothing |
| `run0 meridian-ledger disable` | password at GDM again |

How it works: PAM `pam_exec` runs `/usr/libexec/meridian/ledger-login`, which sends a fresh 32-byte nonce request; the Ledger
signs `SHA256("MERIDIAN-AUTH-V1" || request)` and the signature is checked against the key in `/etc/meridian/ledger/<user>.json`
(root-owned, not group/world writable, else refused). The device's answer alone is never trusted. A small SELinux rule lets GDM
(xdm_t) open the Ledger's hidraw node. Don't register a computer on the Ledger (registered-computers mode refuses these requests).
Since no password is typed at GDM, the GNOME keyring asks for it once after sign-in.

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
| Boot splash, disk PIN screen (stock TPM+PIN unlock) | Plymouth script theme in the initramfs | STABLE (Plymouth script API is years old) | build keeps the stock theme |
| Tighter corners in apps (incl. Flatpaks) | per-user `gtk.css`, copied only if the user has none | STABLE | GTK ignores unknown rules = stock look |
| Ledger-only sign-in (after enrol) | `pam_exec` lines at the top of gdm-password | STABLE (PAM) | build leaves gdm-password stock |
| Fancy Ledger login / lock screen UI | GNOME Shell extension | FRAGILE | only enabled when it declares the image's GNOME version, else stock UI; Ledger prompt still works as text |
| Shell corners (Quick Settings, menus) | would need a shell theme | FRAGILE, not done | n/a |

## Test, switch, roll back
1. Test in a VM first (secureblue ISO in the VM, then rebase the VM).
2. Switch the real laptop only after the VM passes:
   `rpm-ostree rebase ostree-unverified-registry:ghcr.io/lentyrevamped/meridian-os:latest`, reboot, then
   `rpm-ostree rebase ostree-image-signed:docker://ghcr.io/lentyrevamped/meridian-os:latest` (signed from then on).
3. Roll back any time: pick the previous entry in the boot menu, or `rpm-ostree rollback`.
