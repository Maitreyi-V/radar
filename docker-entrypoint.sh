#!/bin/sh
set -e
# Seed the volume on first boot only — never overwrite a database that already has data,
# because it may hold a recorded session that cannot be recreated.
if [ ! -f "$RADAR_DB" ]; then
  echo "no database at $RADAR_DB — seeding with the recorded session"
  mkdir -p "$(dirname "$RADAR_DB")"
  cp /seed/radar.db "$RADAR_DB"
fi
exec "$@"
