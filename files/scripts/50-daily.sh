#!/usr/bin/env bash
# Daily-driver pieces (from meridian2's setup record, 18 Nov 2026). All are plain files, units and defaults: stable.
set -euo pipefail
chmod 0755 /usr/bin/meridian-drive /usr/bin/meridian-keepawake /usr/libexec/meridian/flatpak-setup
chmod 0644 /usr/lib/systemd/user/meridian-drive-sync.service /usr/lib/systemd/user/meridian-drive-sync.timer \
  /usr/lib/systemd/user/meridian-flatpaks.service /usr/share/applications/org.meridian.*.desktop \
  /usr/share/meridian/drive-filters.txt /usr/share/meridian/flathub.filter /usr/share/meridian/flatpaks.list
chmod 0755 /etc/brave /etc/brave/policies /etc/brave/policies/managed
chmod 0644 /etc/brave/policies/managed/meridian-privacy.json
# Drive sync only runs once a user has connected Google Drive (service has ConditionPathExists=~/.config/rclone/rclone.conf)
systemctl --global enable meridian-drive-sync.timer meridian-flatpaks.service
command -v rclone >/dev/null
