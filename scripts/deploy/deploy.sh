#!/usr/bin/env bash
# Release of the committed HEAD to the demo stand (docs/deploy.md).
#
#   scripts/deploy/deploy.sh             build HEAD, deliver, start, check; roll back to the previous release on failure
#   scripts/deploy/deploy.sh deliver     only the first half: build HEAD and deliver its images and release files;
#                                        nothing on the server changes what runs
#   scripts/deploy/deploy.sh start       only the second half: start HEAD, delivered before, check, roll back on failure
#   scripts/deploy/deploy.sh rollback    start the previous release again, with its own compose file
#   scripts/deploy/deploy.sh models      ask each configured model a real question through the stand's own path
#
# Images are built here from `git archive HEAD` (uncommitted changes never reach the stand) and delivered with
# `docker save | ssh docker load`; an image the server already has with the same layers and configuration is only
# re-tagged, so the sandbox and docparse images travel only when they change. DEPLOY_CACHE, a buildx cache backend
# (`type=gha` in CI, docs/deploy.md «Автодеплой»), builds through buildx with the layer cache of each image read from and
# written to it: a builder without local cache then reproduces the very layers the server already has. Every release keeps the files its compose
# file runs with in releases/<release> on the server; starting a release puts them in place first, so a rollback runs
# the previous release exactly as it was released. Nothing here removes volumes or data.
set -euo pipefail

# Images of a release, fsp-career-<name>:<release>.
IMAGES=(app docparse sandbox fsp-mock gpu-tunnel)

HOST=${DEPLOY_HOST:-ensi-new}
DIR=${DEPLOY_DIR:-/root/fsp-career}
ORIGIN=${DEPLOY_ORIGIN:-https://fsp-career.volkv.com}
COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.prod --env-file release.env"
# Files of a release: the compose file and every file of the repository it mounts or reads. Kept per release in
# releases/<release> and copied to the stand directory when the release starts, where the compose file finds the stand's
# own files (.env.prod, the tunnel keys) by the same relative paths.
RELEASE_FILES=(
	docker-compose.prod.yml
	services/docparse/gateway/nginx.conf services/sandbox/gateway/nginx.conf services/sandbox/seccomp.json
)
# Files the release process itself runs on the server (init-env.sh and its template): always those of the newest release.
TOOL_FILES=(.env.prod.example scripts/deploy)

log() { printf '[deploy] %s\n' "$*"; }
remote() { ssh "$HOST" "cd $DIR && $1"; }

public_health() { # <expected commit>
	local body
	for _ in $(seq 1 30); do
		if body=$(curl -fsS --max-time 10 "$ORIGIN/api/health" 2>/dev/null) && [[ $body == *"$1"* ]]; then
			log "public health ok: $body"
			return 0
		fi
		sleep 2
	done
	log "public health check failed: ${body:-no answer}"
	return 1
}

# The release files of a commit into releases/<commit> on the server, from this repository. Only the files the commit has:
# an older release may lack a file a newer one mounts.
deliver_release_files() { # <release>
	git cat-file -e "$1^{commit}" 2>/dev/null \
		|| { log "commit $1 is not in this repository (git fetch), its release files cannot be delivered"; return 1; }
	local files
	mapfile -t files < <(git ls-tree -r --name-only "$1" -- "${RELEASE_FILES[@]}")
	[[ ${#files[@]} -gt 0 ]] || { log "commit $1 has none of the release files"; return 1; }
	git archive "$1" -- "${files[@]}" | ssh "$HOST" "mkdir -p $DIR/releases/$1 && tar -x -C $DIR/releases/$1"
}

# A release started before its files were kept on the server gets them from this repository.
ensure_release_files() { # <release>
	if remote "test -f releases/$1/docker-compose.prod.yml"; then return 0; fi
	log "releases/$1 is not on the server, delivering it from the repository"
	deliver_release_files "$1"
}

start_release() { # <release>; puts its files in place, starts it and waits until every service is healthy
	# The embedder's runtime image (0.8 GB) is pulled first, so that its download is not part of the wait.
	remote "cp -a releases/$1/. . && printf 'FSP_RELEASE=%s\n' '$1' > release.env \
		&& $COMPOSE pull --quiet --policy missing embedder && $COMPOSE up -d --wait --wait-timeout 300 --remove-orphans"
}

# The state of the services and the logs of the app and the worker of a release that did not start, saved on the server
# next to its files before anything restarts the containers, and their end shown here.
save_failure() { # <release>
	local file
	file=releases/$1-failed-$(date -u +%Y%m%dT%H%M%SZ).log
	remote "{ $COMPOSE ps -a; $COMPOSE logs --no-color --timestamps --tail 2000 app worker; } > $file 2>&1" \
		|| log "the state of the services was not saved completely"
	log "state of the services and logs of app and worker: $HOST:$DIR/$file; the end of it:"
	remote "tail -n 60 $file"
}

# The models (docs/models.md, «Три режима»), asked from the app container with the app's own settings: the external
# API or the tunnel to the model machine, the key and the model itself answer, or the probe names the step that did
# not. /health would answer even with a hung engine, so each model gets a real request.
probe_models() {
	ssh "$HOST" 'docker exec -i fsp-career-app node --input-type=module' <<'JS'
const env = process.env;
const probes = [
	['extract', env.LLM_BASE_URL, env.LLM_API_KEY, '/chat/completions',
		{ model: env.LLM_MODEL, messages: [{ role: 'user', content: 'ok' }], max_tokens: 1 }],
	['rerank', env.RERANK_BASE_URL, env.RERANK_API_KEY, '/rerank',
		{ model: env.RERANK_MODEL, query: 'python', documents: ['python'] }]
];
let failed = false;
for (const [name, base, key, path, body] of probes) {
	if (!base) {
		console.log(`${name}: not configured`);
		continue;
	}
	const started = Date.now();
	const took = () => `${Date.now() - started} ms`;
	try {
		const headers = { 'content-type': 'application/json' };
		if (key) headers.authorization = `Bearer ${key}`;
		const res = await fetch(base + path, {
			method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000)
		});
		const detail = res.ok ? '' : ` ${(await res.text()).replace(/\s+/g, ' ').slice(0, 200)}`;
		console.log(`${name}: HTTP ${res.status} in ${took()}${detail}`);
		failed ||= !res.ok;
	} catch (error) {
		console.log(`${name}: ${error.cause?.code ?? error.name} after ${took()}`);
		failed = true;
	}
}
process.exit(failed ? 1 : 0);
JS
}

release_in() { # <file>; the release recorded in a file of the stand directory, empty when there is none
	remote "if [ -f $1 ]; then sed -n 's/^FSP_RELEASE=//p' $1; fi"
}

rollback() {
	local current previous
	current=$(release_in release.env)
	previous=$(release_in release.env.prev)
	[[ -n $previous ]] || { log "no previous release recorded (release.env.prev), nothing to roll back to"; return 1; }
	log "rolling back from ${current:-none} to $previous"
	ensure_release_files "$previous"
	if ! start_release "$previous"; then
		log "rollback to $previous failed"
		save_failure "$previous"
		return 1
	fi
	# The release rolled back from becomes the previous one: a second rollback returns to it.
	if [[ -n $current ]]; then remote "printf 'FSP_RELEASE=%s\n' '$current' > release.env.prev"; fi
	public_health "$previous"
}

# The images of HEAD, built from `git archive HEAD`.
build_images() {
	BUILD=$(mktemp -d)
	trap 'rm -rf "$BUILD"' EXIT
	git archive HEAD | tar -x -C "$BUILD"
	log "building images of $RELEASE${DEPLOY_CACHE:+ (layer cache: $DEPLOY_CACHE)}"
	build_image app "$BUILD" --build-arg "APP_COMMIT=$RELEASE"
	build_image docparse "$BUILD/services/docparse" --target runtime
	build_image sandbox "$BUILD/services/sandbox"
	build_image fsp-mock "$BUILD/services/fsp-mock"
	build_image gpu-tunnel "$BUILD/infra/gpu-tunnel"
}

build_image() { # <name> <context> [build options]; fsp-career-<name>:<release> in the local docker
	local name=$1 context=$2
	shift 2
	if [[ -n ${DEPLOY_CACHE:-} ]]; then
		# mode=max keeps the layers of every stage, not only of the image: a cached build stage is not rebuilt either.
		docker buildx build --quiet --load -t "fsp-career-$name:$RELEASE" \
			--cache-from "$DEPLOY_CACHE,scope=fsp-career-$name" \
			--cache-to "$DEPLOY_CACHE,scope=fsp-career-$name,mode=max" "$@" "$context" >/dev/null
	else
		docker build -q -t "fsp-career-$name:$RELEASE" "$@" "$context" >/dev/null
	fi
}

# The same image under another id: the server keeps images in the containerd store, where the id is the digest of the
# manifest `docker load` writes, while a classic local store names an image by its configuration. Both stores report the
# same layer digests and the same configuration, so an image is recognised by them. How docker prints the configuration
# depends on its version: up to 28 with every field, the empty ones too ("Hostname": "", "Cmd": null), from 29 only
# with the fields the image sets; empty fields are dropped before the comparison, so an image built by docker 28 (the CI
# runner) is recognised in the server's docker 29.
INSPECT='{"layers":{{json .RootFS.Layers}},"config":{{json .Config}}}'
SAME_IMAGE='
import json, sys

def canonical(inspected):
    image = json.loads(inspected)
    config = image["config"] or {}
    return image["layers"], {key: value for key, value in config.items() if value not in (None, "", False, 0, [], {})}

wanted = canonical(sys.argv[1])
refs = [ref for ref, inspected in (line.split(" ", 1) for line in sys.stdin) if canonical(inspected) == wanted]
print(refs[0] if refs else "")
'
# A tagged image of the repository on the server with the layers and configuration of the local image, or nothing; any
# docker failure fails the call.
same_on_server() { # <repository> <local image>
	local wanted
	wanted=$(docker image inspect --format "$INSPECT" "$2")
	ssh "$HOST" sh -s -- "$1" "'$INSPECT'" <<'SH' | python3 -c "$SAME_IMAGE" "$wanted"
repository=$1 template=$2
refs=$(docker images --filter dangling=false --format '{{.Repository}}:{{.Tag}}' "$repository") || exit 1
for ref in $refs; do
	printf '%s ' "$ref"
	docker image inspect --format "$template" "$ref" || exit 1
done
SH
}

# The images and the release files of HEAD onto the server. Nothing that runs there changes: a release delivered and
# never started is removed by the next successful release (its images and files are neither current nor previous).
deliver() {
	build_images
	local name image same
	for name in "${IMAGES[@]}"; do
		image="fsp-career-$name:$RELEASE"
		same=$(same_on_server "fsp-career-$name" "$image")
		if [[ -n $same ]]; then
			ssh "$HOST" "docker tag $same $image"
			log "$image: already on the server as $same, tagged"
		else
			log "$image: sending"
			docker save "$image" | gzip -1 | ssh "$HOST" 'gunzip | docker load -q'
		fi
	done
	log "delivering release files of $RELEASE to $HOST:$DIR/releases/$RELEASE"
	deliver_release_files "$RELEASE"
	log "delivered $RELEASE"
}

# HEAD, delivered before, started; the previous release comes back if it fails.
start() {
	local missing
	missing=$(ssh "$HOST" sh -s -- "$RELEASE" "${IMAGES[@]}" <<'SH'
release=$1
shift
for name in "$@"; do
	docker image inspect "fsp-career-$name:$release" >/dev/null 2>&1 || printf ' %s' "fsp-career-$name:$release"
done
SH
)
	[[ -z $missing ]] || { log "not on the server:$missing; deliver the release first (deploy.sh deliver)"; return 1; }
	ensure_release_files "$RELEASE"

	log "delivering stand files to $HOST:$DIR"
	git archive HEAD "${TOOL_FILES[@]}" | ssh "$HOST" "tar -x -C $DIR"
	remote "scripts/deploy/init-env.sh"

	local previous
	previous=$(release_in release.env)
	if [[ -n $previous && $previous != "$RELEASE" ]]; then
		# The rollback's files are made sure of before anything restarts.
		ensure_release_files "$previous"
		remote "cp release.env release.env.prev"
	fi

	log "starting $RELEASE (previous: ${previous:-none})"
	if start_release "$RELEASE" && public_health "$RELEASE"; then
		# Keep the images of this release and of the one a rollback starts (release.env.prev: after a second release of the
		# same commit it is not the release this one replaced); older releases of the stand are removed. Only the stand's
		# own repositories are touched, never other projects' images. The server has no build cache of the stand to prune:
		# images are built here and loaded there.
		local rollback_to repositories
		rollback_to=$(release_in release.env.prev)
		repositories=$(IFS='|'; echo "${IMAGES[*]}")
		remote "docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^fsp-career-($repositories):' \
			| grep -vE ':(${RELEASE}${rollback_to:+|$rollback_to})\$' | xargs -r docker rmi" || log "old images were not removed"
		# The files of the releases whose images are gone go with them; the logs of failed releases stay.
		remote "for d in releases/*/; do [ -d \"\$d\" ] || continue; case \$(basename \"\$d\") in \
			$RELEASE${rollback_to:+|$rollback_to}) ;; *) rm -rf \"\$d\" ;; esac; done" || log "old release files were not removed"
		log "released $RELEASE"
		# The stand works without the models, so their state does not decide the release; it is reported.
		log "models through the tunnel:"
		probe_models || log "some models do not answer: the stand works without them (docs/models.md, «Без модели»)"
		return 0
	fi

	log "release $RELEASE failed"
	save_failure "$RELEASE"
	if [[ -n $previous && $previous != "$RELEASE" ]]; then
		rollback
	fi
	return 1
}

cd "$(git rev-parse --show-toplevel)"

case ${1:-} in
	rollback) rollback; exit ;;
	models) probe_models; exit ;;
	'' | deliver | start) ;;
	*) echo "usage: $0 [deliver | start | rollback | models]" >&2; exit 2 ;;
esac

RELEASE=$(git rev-parse --short=12 HEAD)
if [[ -n $(git status --porcelain) ]]; then
	log "working tree has uncommitted changes; they are not deployed, only HEAD $RELEASE is"
fi

case ${1:-} in
	deliver) deliver ;;
	start) start ;;
	'')
		deliver
		start
		;;
esac
