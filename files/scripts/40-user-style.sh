#!/usr/bin/env bash
# Turn on the per-user GTK corner style for every user (it never overwrites a user's own gtk.css).
set -euo pipefail
systemctl --global enable meridian-style.service
chmod 0755 /usr/share/meridian /usr/share/meridian/gtk-4.0 /usr/share/meridian/gtk-3.0
chmod 0644 /usr/share/meridian/*.svg /usr/share/meridian/*.png /usr/share/meridian/gtk-*/gtk.css
