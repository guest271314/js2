#!/bin/bash
# Runs as the image's default user (node), so start sshd via the
# passwordless-sudo rule set up for exactly this in the Dockerfile.
# This must run on every container start/restart, not just via
# devcontainer postStartCommand (which is client-tooling-driven and does
# NOT re-fire on a bare `docker restart` — sshd used to silently stay down
# after a restart until a Claude Code session happened to start).
mkdir -p /var/run/sshd 2>/dev/null || true

# Persist sshd host keys across image rebuilds and container recreations so
# clients' known_hosts stay valid (the image-baked /etc/ssh keys change on every
# image build, which triggers "REMOTE HOST IDENTIFICATION HAS CHANGED" errors).
# Keys are generated once as the (node) user into the persistent /home/node/.ssh
# volume; sshd is then pointed at them with -h, which overrides the ephemeral
# /etc/ssh keys. (Generation avoids sudo — only sshd/chown/init-firewall are in
# the passwordless-sudo whitelist.)
mkdir -p /home/node/.ssh/hostkeys && chmod 700 /home/node/.ssh/hostkeys
for t in ed25519 rsa ecdsa; do
  [ -f "/home/node/.ssh/hostkeys/ssh_host_${t}_key" ] || \
    ssh-keygen -q -t "$t" -f "/home/node/.ssh/hostkeys/ssh_host_${t}_key" -N ''
done
sudo /usr/sbin/sshd -p 2222 \
  -h /home/node/.ssh/hostkeys/ssh_host_ed25519_key \
  -h /home/node/.ssh/hostkeys/ssh_host_rsa_key \
  -h /home/node/.ssh/hostkeys/ssh_host_ecdsa_key 2>/dev/null || true

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
