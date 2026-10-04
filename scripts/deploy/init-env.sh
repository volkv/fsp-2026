#!/usr/bin/env bash
# Creates the stand's .env.prod from .env.prod.example with freshly generated secrets. Runs on the server, in the
# stand directory (deploy.sh calls it on every release). An existing .env.prod keeps every line it has: the encryption
# keys, the HMAC secret and the receipt signing keys it holds are bound to stored data. Keys the template gained since
# are appended to it — a generated secret for a secret, the template's value for a setting (the demonstration mode,
# for example) — and named in the output. It also prepares the keys of the model tunnel (below). Prints no secret
# values.
set -euo pipefail

cd "$(dirname "$0")/../.."
target=.env.prod
template=.env.prod.example

[[ -f $template ]] || { echo "init-env: $template not found" >&2; exit 1; }
command -v openssl >/dev/null || { echo "init-env: openssl is required" >&2; exit 1; }

b64() { openssl rand -base64 32; }
hex() { openssl rand -hex 24; }

declare -A generated=(
	[FIELD_ENCRYPTION_KEYS]="1:$(b64)"
	[FIELD_HMAC_SECRET]="$(b64)"
	[RECEIPT_SIGNING_KEYS]="stand-1:$(b64)"
	[POSTGRES_PASSWORD]="$(hex)"
	[REDIS_PASSWORD]="$(hex)"
	[S3_SECRET_ACCESS_KEY]="$(hex)"
	[FSP_ID_CLIENT_SECRET]="$(hex)"
	[FSP_WEBHOOK_SECRET]="$(hex)"
	[FSP_ASSERTION_SECRET]="$(hex)"
	[FSP_MOCK_CONTROL_TOKEN]="$(hex)"
	[BOOTSTRAP_ADMIN_PASSWORD]="$(hex)"
)

# Checks the template: every generated key has an empty line there.
while IFS= read -r line || [[ -n $line ]]; do
	key=${line%%=*}
	if [[ $line == *=* && -n ${generated[$key]+set} && $line != "$key=" ]]; then
		echo "init-env: $template must leave $key empty" >&2
		exit 1
	fi
done <"$template"
for key in "${!generated[@]}"; do
	grep -q "^$key=" "$template" || { echo "init-env: $template has no line for: $key" >&2; exit 1; }
done

# The value a key gets in a new file: generated for a secret, the template's own otherwise.
value_of() {
	local line=$1 key=${1%%=*}
	if [[ -n ${generated[$key]+set} ]]; then printf '%s=%s\n' "$key" "${generated[$key]}"; else printf '%s\n' "$line"; fi
}

umask 077

# Keys of the reverse tunnel from the model machine (docs/models.md, «Модели вне стенда: обратный туннель»), mounted
# into the tunnel container read-only. The host key is generated once and never replaced: the machine has pinned it.
# The machine's public key is put here by hand; without it the tunnel cannot start, so the release stops here, before
# anything is restarted. The directory belongs to the container's account (uid 10022, infra/gpu-tunnel/Dockerfile).
tunnel_dir=gpu-tunnel
tunnel_uid=10022
command -v ssh-keygen >/dev/null || { echo "init-env: ssh-keygen is required" >&2; exit 1; }
mkdir -p "$tunnel_dir"
if [[ ! -e $tunnel_dir/ssh_host_ed25519_key ]]; then
	ssh-keygen -q -t ed25519 -N '' -C fsp-career-gpu-tunnel -f "$tunnel_dir/ssh_host_ed25519_key"
	echo "init-env: generated the tunnel host key $(ssh-keygen -l -f "$tunnel_dir/ssh_host_ed25519_key.pub")"
fi
if [[ ! -s $tunnel_dir/client_ed25519.pub ]]; then
	echo "init-env: $PWD/$tunnel_dir/client_ed25519.pub is missing: put the model machine's public tunnel key there" >&2
	exit 1
fi
chown -R "$tunnel_uid:$tunnel_uid" "$tunnel_dir"
chmod 700 "$tunnel_dir"
chmod 600 "$tunnel_dir"/*

if [[ -e $target ]]; then
	added=()
	while IFS= read -r line || [[ -n $line ]]; do
		key=${line%%=*}
		[[ $line == *=* && $line != \#* ]] || continue
		grep -q "^$key=" "$target" && continue
		value_of "$line" >>"$target"
		added+=("$key")
	done <"$template"
	if ((${#added[@]} > 0)); then
		echo "init-env: $target exists, added keys of the template: ${added[*]}"
	else
		echo "init-env: $target exists, left as is"
	fi
	exit 0
fi

tmp=$(mktemp "$target.XXXXXX")
trap 'rm -f "$tmp"' EXIT
while IFS= read -r line || [[ -n $line ]]; do
	if [[ $line == *=* && $line != \#* ]]; then value_of "$line"; else printf '%s\n' "$line"; fi
done <"$template" >"$tmp"
chmod 600 "$tmp"
mv "$tmp" "$target"
trap - EXIT
echo "init-env: created $target (mode 600) with generated secrets"
