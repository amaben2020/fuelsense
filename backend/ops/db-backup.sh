#!/bin/bash
# Nightly logical backup of the production database to S3.
#
# RDS automated backups only reach back as far as the retention period (1 day
# while the account is on the AWS free-tier plan), and they cannot be restored
# anywhere except RDS. This produces a portable pg_dump that survives both
# limits: it is readable by any Postgres, and objects here outlive whatever the
# retention window happens to be.
#
# Runs as a systemd timer, not crond — Amazon Linux 2023 ships no cron daemon.
# See fuelsense-db-backup.timer.

set -euo pipefail

ENV_FILE=/home/ec2-user/backend/.env
PG_BIN=/opt/pg16
WORK_DIR=/var/tmp

# The box's packaged client is pg15, and pg_dump refuses to read a server newer
# than itself — RDS is 16.x. These binaries are extracted from the postgresql16
# RPM into /opt/pg16 because installing that package would file-conflict with
# postgresql15, which is still present for the (now retired) local server.
export LD_LIBRARY_PATH="$PG_BIN"

if [[ ! -x "$PG_BIN/pg_dump" ]]; then
  echo "FATAL: $PG_BIN/pg_dump missing — see ops/README for how it is installed" >&2
  exit 1
fi

# DATABASE_URL and BACKUP_BUCKET both live in the app's .env so there is one
# place to rotate the database password. Parsed rather than sourced: the file
# contains values with characters the shell would otherwise expand.
get_env() {
  grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | sed 's/^"//; s/"$//'
}

DATABASE_URL=$(get_env DATABASE_URL)
BACKUP_BUCKET=$(get_env BACKUP_BUCKET)

: "${DATABASE_URL:?DATABASE_URL not found in $ENV_FILE}"
: "${BACKUP_BUCKET:?BACKUP_BUCKET not found in $ENV_FILE}"

STAMP=$(date -u +%Y%m%d-%H%M%S)
DUMP="$WORK_DIR/fuelsense-$STAMP.dump"
KEY="postgres/$(date -u +%Y/%m)/fuelsense-$STAMP.dump"

# Always clean up the local copy, including on failure — /var/tmp shares the
# 8 GB root volume with Postgres and the app, and it has run as high as 78%.
cleanup() { rm -f "$DUMP"; }
trap cleanup EXIT

echo "dumping to $DUMP"
"$PG_BIN/pg_dump" -Fc --no-owner --no-privileges -f "$DUMP" "$DATABASE_URL"

# A dump that cannot be listed cannot be restored. Catching that here means a
# corrupt backup fails loudly tonight instead of silently during a recovery.
echo "verifying archive integrity"
"$PG_BIN/pg_restore" --list "$DUMP" > /dev/null

SIZE=$(stat -c %s "$DUMP")
if (( SIZE < 10240 )); then
  echo "FATAL: dump is only ${SIZE}B — refusing to upload a suspect backup" >&2
  exit 1
fi

echo "uploading s3://$BACKUP_BUCKET/$KEY (${SIZE}B)"
aws s3 cp "$DUMP" "s3://$BACKUP_BUCKET/$KEY" --only-show-errors

echo "backup complete: s3://$BACKUP_BUCKET/$KEY"
