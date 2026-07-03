#!/bin/bash
# Runs as the image's default user (node), so start sshd via the
# passwordless-sudo rule set up for exactly this in the Dockerfile.
# This must run on every container start/restart, not just via
# devcontainer postStartCommand (which is client-tooling-driven and does
# NOT re-fire on a bare `docker restart` — sshd used to silently stay down
# after a restart until a Claude Code session happened to start).
mkdir -p /var/run/sshd 2>/dev/null || true
sudo /usr/sbin/sshd -p 2222 2>/dev/null || true

if [ "$#" -gt 0 ]; then
  # Devcontainer CLI (or a future setup) supplied a real command — exec it.
  exec "$@"
else
  # No command supplied: keep the container alive ourselves (mirrors the
  # devcontainer CLI's own keep-alive wrapper) instead of exiting once sshd
  # is backgrounded.
  trap 'exit 0' TERM INT
  while sleep 1 & wait $!; do :; done
fi
