#!/bin/sh
# Builds the authorized_keys of the account `tunnel` from the model machine's public key and runs sshd in the
# foreground. Both keys come from the key directory mounted at /keys (scripts/deploy/init-env.sh creates it on the
# server): ssh_host_ed25519_key is the host key the machine has pinned, client_ed25519.pub is the machine's key.
set -eu

host_key=/keys/ssh_host_ed25519_key
client_key=/keys/client_ed25519.pub

[ -r "$host_key" ] || { echo "gpu-tunnel: no readable host key $host_key" >&2; exit 1; }
[ -r "$client_key" ] || { echo "gpu-tunnel: no readable client key $client_key" >&2; exit 1; }
if [ "$(grep -c . "$client_key")" != 1 ] || ! grep -q '^ssh-ed25519 [A-Za-z0-9+/=]* *[^ ]*$' "$client_key"; then
	echo "gpu-tunnel: $client_key must hold exactly one ssh-ed25519 public key" >&2
	exit 1
fi
echo "gpu-tunnel: client key $(ssh-keygen -l -f "$client_key")" >&2

# The key options repeat the daemon's limits, so a change of sshd_config alone does not widen what the key may do.
umask 077
printf 'restrict,port-forwarding,permitlisten="57810",permitlisten="57801" %s\n' "$(grep . "$client_key")" \
	>/run/tunnel/authorized_keys

exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
