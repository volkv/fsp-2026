#!/usr/bin/env bash
# Starts the application image the way the stand does and fails unless the server becomes healthy (docs/development.md,
# «Полный гейт»). `docker build` proves only that the image builds: the start command of the image (Dockerfile, CMD)
# runs the migrations and the publications with plain Node from the copied sources, so a module missing from the image
# or a failing publication surfaces only here. The image runs with its own command, unchanged, against a PostgreSQL and
# a Valkey of its own on an internal network of its own: empty, as on a new stand, and gone after the check. Nothing of
# the development stand (.env, compose.yaml, its volumes and ports) is touched.
#
#   scripts/check-image.sh <image>
set -euo pipefail

IMAGE=${1:?usage: scripts/check-image.sh <image>}
# Seconds the start may take: migrations and publications of an empty database take about half a minute.
START_TIMEOUT=${CHECK_IMAGE_TIMEOUT:-180}

cd "$(dirname "$0")/.."
# The database and the cache of the stand, as the stand runs them.
image_of() { # <service of docker-compose.prod.yml>
	local image
	image=$(sed -n "/^  $1:\$/,/^  [a-z]/s/^    image: //p" docker-compose.prod.yml)
	[[ -n $image ]] || { echo "check-image: no image of the service $1 in docker-compose.prod.yml" >&2; exit 1; }
	printf '%s' "$image"
}
POSTGRES_IMAGE=$(image_of postgres)
REDIS_IMAGE=$(image_of redis)
# The client address of the stand: its server takes it from the header the proxy sets, so a request straight to it — the
# health check of the container — has none, and a start that reads the address of such a request is not healthy.
app_env() { # <variable of x-app-environment in docker-compose.prod.yml>
	local value
	value=$(sed -n "/^x-app-environment:/,/^[^ ]/s/^  $1: //p" docker-compose.prod.yml)
	[[ -n $value ]] || { echo "check-image: no $1 in x-app-environment of docker-compose.prod.yml" >&2; exit 1; }
	value=${value#\'}
	printf '%s' "${value%\'}"
}
ADDRESS_HEADER=$(app_env ADDRESS_HEADER)
XFF_DEPTH=$(app_env XFF_DEPTH)

RUN=fsp-image-check-$(openssl rand -hex 4)
NETWORK=$RUN
DB_PASSWORD=$(openssl rand -hex 16)
REDIS_PASSWORD=$(openssl rand -hex 16)

log() { printf '[check-image] %s\n' "$*"; }
cleanup() {
	docker rm -f "$RUN-app" "$RUN-postgres" "$RUN-redis" >/dev/null 2>&1 || true
	docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# CHECK_IMAGE_SUBNET — the subnet of the network, for a Docker whose default address pools are used up.
docker network create --internal ${CHECK_IMAGE_SUBNET:+--subnet "$CHECK_IMAGE_SUBNET"} "$NETWORK" >/dev/null
docker run -d --name "$RUN-postgres" --network "$NETWORK" --network-alias postgres \
	--tmpfs /var/lib/postgresql/data --shm-size 128m \
	-e POSTGRES_DB=fsp -e POSTGRES_USER=fsp -e POSTGRES_PASSWORD="$DB_PASSWORD" "$POSTGRES_IMAGE" >/dev/null
docker run -d --name "$RUN-redis" --network "$NETWORK" --network-alias redis \
	"$REDIS_IMAGE" valkey-server --requirepass "$REDIS_PASSWORD" --save '' >/dev/null

# Over TCP: while the image initialises the database, its temporary server listens on the socket only.
for _ in $(seq 1 60); do
	docker exec "$RUN-postgres" pg_isready -q -h 127.0.0.1 -U fsp -d fsp && break
	sleep 1
done
docker exec "$RUN-postgres" pg_isready -q -h 127.0.0.1 -U fsp -d fsp \
	|| { log "PostgreSQL did not start"; docker logs "$RUN-postgres" 2>&1 | tail -20; exit 1; }

# The settings of the local environment template (every required variable with a valid value), with the database and the
# cache above, the header of the client address of the stand, and every step of the start switched on: the embedding
# space, the bootstrap administrator and the demonstration mode, as on the stand. The services the start does not reach
# (storage, mail, parser, sandbox, FSP) stay at the template's addresses, unreachable from the internal network.
log "starting $IMAGE"
docker run -d --name "$RUN-app" --network "$NETWORK" \
	--cap-drop ALL --security-opt no-new-privileges \
	--env-file .env.example \
	-e DATABASE_URL="postgres://fsp:$DB_PASSWORD@postgres:5432/fsp" \
	-e REDIS_URL="redis://:$REDIS_PASSWORD@redis:6379" \
	-e EMBED_BASE_URL=http://embedder:8080/v1 -e EMBED_MODEL=bge-m3 \
	-e EMBED_SPACE_ID=bge-m3@aa473d51f451/q:none/d:none/cls/l2/1024/t512/sections-v1 \
	-e BOOTSTRAP_ADMIN_EMAIL=admin@image-check.invalid -e BOOTSTRAP_ADMIN_PASSWORD="$(openssl rand -hex 12)" \
	-e DEMO_MODE=true \
	-e ADDRESS_HEADER="$ADDRESS_HEADER" -e XFF_DEPTH="$XFF_DEPTH" \
	"$IMAGE" >/dev/null

HEALTH="fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
started=$SECONDS
while ((SECONDS - started < START_TIMEOUT)); do
	if [[ $(docker inspect -f '{{.State.Running}}' "$RUN-app") != true ]]; then
		log "the start command of $IMAGE exited with $(docker inspect -f '{{.State.ExitCode}}' "$RUN-app"):"
		docker logs "$RUN-app" 2>&1 | tail -40
		exit 1
	fi
	if docker exec "$RUN-app" node -e "$HEALTH" 2>/dev/null; then
		log "$IMAGE started and is healthy in $((SECONDS - started)) s"
		exit 0
	fi
	sleep 2
done
log "$IMAGE is not healthy after $START_TIMEOUT s:"
docker logs "$RUN-app" 2>&1 | tail -40
exit 1
