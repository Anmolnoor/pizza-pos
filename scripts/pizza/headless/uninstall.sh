#!/usr/bin/env bash
# Stops and removes the POS user service, the backup timer and the kit's settings file.
# The data folder and its backups are left in place.
set -euo pipefail

config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
unit_dir="$config_home/systemd/user"

systemctl --user disable --now pizza-pos-backup.timer pizza-pos.service
systemctl --user stop pizza-pos-backup.service
rm -f "$unit_dir/pizza-pos.service" "$unit_dir/pizza-pos-backup.service" "$unit_dir/pizza-pos-backup.timer"
rm -f "$config_home/pizza-pos/headless.env"
rmdir --ignore-fail-on-non-empty "$config_home/pizza-pos"
systemctl --user daemon-reload
echo "Removed the pizza-pos service, backup timer and settings. Data folders were not touched."
