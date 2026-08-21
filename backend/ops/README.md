# Ops — production database and backups

The production database is **Amazon RDS** `fuelsense-prod` (`eu-north-1c`,
PostgreSQL 16.15, `db.t4g.micro`), migrated off the EC2 box's own disk on
2026-08-21. It is not publicly reachable: security group
`sg-072efb466379bfe8a` admits TCP 5432 from the backend's security group
(`sg-06c0501032767e6a1`) and nothing else.

## Why a nightly dump when RDS already has backups

RDS automated backups only reach back as far as the retention period, and they
can only be restored *into RDS*. Two gaps follow:

- The AWS account is on the **Free Tier plan**, which caps retention at **1
  day**. Live data is unaffected — this limits only how far back you can
  rewind. Once the account plan is upgraded, raise it in one call:
  `aws rds modify-db-instance --db-instance-identifier fuelsense-prod
  --backup-retention-period 7 --apply-immediately`.
- A `pg_dump` is portable. It restores into any Postgres, including one that is
  not on AWS, which is the copy you want if the account itself becomes
  unavailable.

A manual snapshot, `fuelsense-post-migration-20260821`, sits outside the
retention window entirely and will persist until explicitly deleted.

## Files

| File | Role |
|---|---|
| `db-backup.sh` | Dumps the database, verifies the archive is listable, uploads to S3 |
| `fuelsense-db-backup.service` | oneshot systemd unit invoking the script |
| `fuelsense-db-backup.timer` | Nightly at 01:30 UTC, `Persistent=true` |
| `iam-backend-s3-policy.json` | Permission policy for the EC2 instance role |
| `iam-backend-trust-policy.json` | Trust policy letting EC2 assume that role |

Amazon Linux 2023 ships no cron daemon, so this is a systemd timer rather than
a crontab entry. `Persistent=true` means a night missed because the box was off
runs at next boot instead of being skipped silently.

## The pg16 client at `/opt/pg16`

`pg_dump` refuses to read a server newer than itself, and RDS is 16.x while the
box's packaged client is 15.16. Installing `postgresql16` is not possible — it
file-conflicts with `postgresql15`, which is still present for the retired local
server. So the 16 binaries are extracted from the RPM instead:

```bash
cd /tmp && mkdir pg16x && cd pg16x
sudo dnf download postgresql16 postgresql16-private-libs --destdir=/tmp/pg16x
for f in *.rpm; do rpm2cpio "$f" | cpio -idm --quiet; done
sudo mkdir -p /opt/pg16
sudo cp -a usr/bin/pg_dump usr/bin/pg_restore usr/bin/psql /opt/pg16/
sudo cp -a usr/lib64/* /opt/pg16/
```

The script sets `LD_LIBRARY_PATH=/opt/pg16` so those binaries find their libs.
Once the local Postgres 15 server is removed, `postgresql15` can be uninstalled
and `postgresql16` installed normally, making `/opt/pg16` redundant.

## Enabling the nightly backup

Prerequisites — neither exists yet:

1. **Bucket** `fuelsense-db-backups` in `eu-north-1`, with public access
   blocked, versioning enabled, and a lifecycle rule expiring noncurrent
   versions after ~30 days.
2. **Instance role.** The EC2 instance currently has **no instance profile at
   all**, so nothing on it can authenticate to S3.

```bash
aws iam create-role --role-name FuelSenseBackendRole \
  --assume-role-policy-document file://ops/iam-backend-trust-policy.json
aws iam put-role-policy --role-name FuelSenseBackendRole \
  --policy-name FuelSenseBackupWrite \
  --policy-document file://ops/iam-backend-s3-policy.json
aws iam create-instance-profile --instance-profile-name FuelSenseBackendProfile
aws iam add-role-to-instance-profile \
  --instance-profile-name FuelSenseBackendProfile --role-name FuelSenseBackendRole
aws ec2 associate-iam-instance-profile --region eu-north-1 \
  --instance-id i-02365bd7ac603ace3 \
  --iam-instance-profile Name=FuelSenseBackendProfile
```

Then on the box:

```bash
echo 'BACKUP_BUCKET=fuelsense-db-backups' >> /home/ec2-user/backend/.env
chmod +x /home/ec2-user/backend/ops/db-backup.sh
sudo cp /home/ec2-user/backend/ops/fuelsense-db-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fuelsense-db-backup.timer
sudo systemctl start fuelsense-db-backup.service   # test it immediately
journalctl -u fuelsense-db-backup -n 30 --no-pager
```

Confirm the timer is scheduled with `systemctl list-timers fuelsense-db-backup`.

## Restoring from a nightly dump

```bash
aws s3 cp s3://fuelsense-db-backups/postgres/2026/08/fuelsense-YYYYMMDD-HHMMSS.dump .
LD_LIBRARY_PATH=/opt/pg16 /opt/pg16/pg_restore --no-owner --no-privileges \
  -d "$DATABASE_URL" fuelsense-YYYYMMDD-HHMMSS.dump
```

Restoring over a populated database fails on the first "already exists" — drop
and recreate the schema first (`DROP SCHEMA public CASCADE; CREATE SCHEMA
public;`) so the restore starts clean.

## The systemd unit is `fuelsense`

Not `fuelsense-backend`. Until 2026-08-21 both existed and were enabled, racing
for ports 5027/5001 on every boot; the loser crash-looped to `failed`. The
duplicate has been moved to `/root/removed-units/`. Deploy docs that say
`fuelsense-backend` are restarting a unit that no longer exists.
