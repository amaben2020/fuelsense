#!/bin/bash
# Keeps the SSH tunnel to the production database alive. The tunnel has been
# observed dropping every 30-60 minutes even with SSH keepalive flags — likely
# the laptop's network interface sleeping/switching, not an EC2-side timeout.
# This checks the local end of the tunnel every 15s and re-establishes it the
# moment it's down, so a drop is invisible instead of a live "Couldn't reach
# the server" error mid-demo.
#
# Since 2026-08-21 the database is Amazon RDS, which is deliberately not
# publicly reachable — its security group admits only the EC2 backend. So the
# forward now terminates at the RDS endpoint rather than the box's own
# Postgres, with the EC2 instance acting purely as the jump host.
#
# Run detached: nohup ./tunnel-watchdog.sh > tunnel-watchdog.log 2>&1 & disown
# Stop it: pkill -f tunnel-watchdog.sh

TUNNEL_PORT=15432
REMOTE_HOST="ec2-13-61-2-216.eu-north-1.compute.amazonaws.com"
DB_HOST="fuelsense-prod.cf0m8smsiksj.eu-north-1.rds.amazonaws.com"
SSH_KEY="$HOME/.ssh/fuelsense.pem"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# Whether the tunnel looks alive.
#
# Two conditions, deliberately both cheap and both conservative. The port must
# accept, and an ssh carrying *this* forward must still exist — a listener with
# no ssh behind it is the corpse case, where the local socket keeps accepting
# while nothing reaches the far end.
#
# An earlier version tried to prove the whole path by sending a Postgres
# SSLRequest and reading the server's one-byte reply. It was too eager: any
# hiccup in that exchange read as "dead" and the watchdog tore down a perfectly
# good tunnel, then did it again fifteen seconds later. A check that
# occasionally misses a failure is recoverable; one that manufactures failures
# is not.
tunnel_alive() {
  nc -z -w2 localhost "$TUNNEL_PORT" 2>/dev/null || return 1
  pgrep -f "$TUNNEL_PORT:$DB_HOST:5432" >/dev/null 2>&1
}

while true; do
  if ! tunnel_alive; then
    log "tunnel not answering, restarting..."

    # Clear the corpse first. Without this the replacement dies instantly on
    # ExitOnForwardFailure because the dead tunnel still holds the port, and
    # the watchdog retries that forever without ever recovering — the exact
    # livelock seen on 2026-08-22 ("restart failed, will retry" on a loop).
    pkill -f "$TUNNEL_PORT:$DB_HOST:5432" 2>/dev/null
    sleep 1

    ssh -i "$SSH_KEY" \
      -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o TCPKeepAlive=yes \
      -o ConnectTimeout=10 \
      -N -L "$TUNNEL_PORT:$DB_HOST:5432" \
      "ec2-user@$REMOTE_HOST" &

    # An SSH handshake over a slow link takes longer than the 3s the old
    # version allowed, which made healthy restarts look like failures.
    for _ in 1 2 3 4 5 6 7 8; do
      sleep 1
      if tunnel_alive; then break; fi
    done

    if tunnel_alive; then
      log "tunnel back up"
    else
      log "restart failed, will retry"
    fi
  fi
  sleep 15
done
