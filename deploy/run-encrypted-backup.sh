#!/bin/sh
set -eu

container="${HOMECAM_SERVER_CONTAINER:-homecam-server}"
exec docker exec "$container" python -m app.scripts.run_backup
