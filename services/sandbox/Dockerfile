# syntax=docker/dockerfile:1

# Code execution sandbox (docs/contracts.md, section 6): go-judge with the language toolchains. Every toolchain comes
# from a pinned upstream image; g++ comes from a fixed Debian snapshot, so every build installs the same versions.
ARG GO_JUDGE_VERSION=v1.12.3
ARG PYTHON_IMAGE=python:3.13.15-slim-trixie
ARG GO_IMAGE=golang:1.27.1-trixie
ARG NODE_IMAGE=node:24.21.0-trixie-slim
ARG JDK_IMAGE=eclipse-temurin:21.0.12_8-jdk-noble

FROM ${GO_IMAGE} AS go

# go-judge from its module at the pinned version (checked against the Go checksum database), built with the seccomp
# tag: the released binary lacks it and silently ignores -seccomp-conf. The other tags are those of the release.
FROM go AS go-judge
ARG GO_JUDGE_VERSION
RUN CGO_ENABLED=0 GOBIN=/opt/go-judge go install -trimpath -ldflags=-s -tags seccomp,nomsgpack,grpcnotrace \
		github.com/criyle/go-judge/cmd/go-judge@${GO_JUDGE_VERSION}

FROM ${NODE_IMAGE} AS node
FROM ${JDK_IMAGE} AS jdk

FROM ${PYTHON_IMAGE} AS runtime
ARG DEBIAN_SNAPSHOT=20260924T000000Z
RUN rm -f /etc/apt/sources.list.d/debian.sources \
	&& printf '%s\n' \
		"deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} trixie main" \
		"deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} trixie-updates main" \
		"deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT} trixie-security main" \
		> /etc/apt/sources.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends g++ \
	&& rm -rf /var/lib/apt/lists/*

# Programs see only /usr, /bin, /lib, /lib64 and a few files of /etc (mount.yaml), so every toolchain lives under /usr.
COPY --from=go /usr/local/go /usr/local/go
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=jdk /opt/java/openjdk /usr/local/lib/jvm/temurin-21
COPY --from=go-judge /opt/go-judge/go-judge /usr/local/sbin/go-judge
COPY ts-strip.js /usr/local/lib/sandbox/ts-strip.js

# The standard library of Go compiled once into a read-only build cache: a submission then compiles only its own
# package instead of the runtime and every package it imports (about 10 s of CPU otherwise). The environment must
# match the `go` compile environment in languages.json, or the cache keys differ.
RUN env PATH=/usr/local/go/bin:$PATH GOCACHE=/usr/local/lib/go-cache GOFLAGS=-trimpath GOTOOLCHAIN=local \
		CGO_ENABLED=0 GO111MODULE=off go build std \
	&& chmod -R a+rX,a-w /usr/local/lib/go-cache

COPY mount.yaml seccomp.yaml languages.json render-languages.py healthcheck.py entrypoint.sh /etc/sandbox/
RUN PATH=/usr/local/go/bin:/usr/local/lib/jvm/temurin-21/bin:$PATH \
		python3 /etc/sandbox/render-languages.py /etc/sandbox/languages.json /etc/sandbox/languages.resolved.json \
	&& rm /etc/sandbox/render-languages.py /etc/sandbox/languages.json \
	&& printf '%s\n' 'root:x:0:0::/w:/usr/sbin/nologin' 'sandbox:x:1536:1536::/w:/usr/sbin/nologin' > /etc/sandbox/passwd

EXPOSE 5050
HEALTHCHECK --interval=5s --timeout=5s --start-period=10s --retries=20 CMD ["python3", "/etc/sandbox/healthcheck.py"]
ENTRYPOINT ["/etc/sandbox/entrypoint.sh"]
# -no-fallback: without cgroups go-judge would silently run programs with rlimits only, so it must refuse to start.
# -container-cred-start: every environment runs as its own unprivileged uid outside the user namespace.
# -parallelism 2: two programs at once (docs/contracts.md, section 6.2); compose.yaml sizes memory and CPU for that.
# -src-prefix: programs cannot be fed files of this container by path, only by content.
# -file-timeout: compiled programs left in the file store after a dropped request are removed.
CMD ["-http-addr=:5050", "-mount-conf=/etc/sandbox/mount.yaml", "-no-fallback", "-container-cred-start=10000", \
	"-parallelism=2", "-pre-fork=2", "-src-prefix=/nonexistent", "-file-timeout=5m", "-output-limit=64m", \
	"-copy-out-limit=64m"]
