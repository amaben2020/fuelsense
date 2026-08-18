#!/bin/bash
# Keeps the SSH tunnel to EC2's production Postgres alive. The tunnel has been
# observed dropping every 30-60 minutes even with SSH keepalive flags — likely
# the laptop's network interface sleeping/switching, not an EC2-side timeout.
# This checks the local end of the tunnel every 15s and re-establishes it the
# moment it's down, so a drop is invisible instead of a live "Couldn't reach
# the server" error mid-demo.
#
# Run detached: nohup ./tunnel-watchdog.sh > tunnel-watchdog.log 2>&1 & disown
# Stop it: pkill -f tunnel-watchdog.sh

TUNNEL_PORT=15432
REMOTE_HOST="ec2-13-61-2-216.eu-north-1.compute.amazonaws.com"
SSH_KEY="$HOME/.ssh/fuelsense.pem"

while true; do
  if ! nc -z -w2 localhost "$TUNNEL_PORT" 2>/dev/null; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] tunnel down, restarting..."
    ssh -i "$SSH_KEY" \
      -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o TCPKeepAlive=yes \
      -o ConnectTimeout=10 \
      -N -L "$TUNNEL_PORT:localhost:5432" \
      "ec2-user@$REMOTE_HOST" &
    sleep 3
    if nc -z -w2 localhost "$TUNNEL_PORT" 2>/dev/null; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] tunnel back up"
    else
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] restart failed, will retry"
    fi
  fi
  sleep 15
done
