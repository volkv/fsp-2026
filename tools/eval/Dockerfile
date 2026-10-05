# syntax=docker/dockerfile:1

ARG PYTHON_IMAGE=python:3.13.15-slim-trixie
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.12.18
ARG NODE_IMAGE=node:24.21.0-trixie-slim

FROM ${UV_IMAGE} AS uv
FROM ${NODE_IMAGE} AS node

# The harness renders resumes with a Unicode font and calls the application's evaluation bridge with Node (the same
# major version as the application). System packages come from a fixed Debian snapshot.
FROM ${PYTHON_IMAGE} AS system
ARG DEBIAN_SNAPSHOT=20260924T000000Z
RUN rm -f /etc/apt/sources.list.d/debian.sources \
	&& printf '%s\n' \
		"deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} trixie main" \
		"deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT} trixie-security main" \
		> /etc/apt/sources.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends fonts-dejavu-core tini \
	&& rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
ENV PYTHONDONTWRITEBYTECODE=1 \
	PYTHONUNBUFFERED=1 \
	PYTHONPATH=/app/src \
	PATH=/app/.venv/bin:$PATH \
	UV_PROJECT_ENVIRONMENT=/app/.venv \
	UV_LINK_MODE=copy \
	UV_PYTHON_DOWNLOADS=never
WORKDIR /app

FROM system AS deps
COPY --from=uv /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,id=fsp-eval-uv,target=/root/.cache/uv \
	uv sync --frozen --no-dev --no-install-project --compile-bytecode

FROM system AS runtime
COPY --from=deps /app/.venv /app/.venv
COPY pyproject.toml uv.lock thresholds.json ./
COPY datasets ./datasets
COPY src ./src
ENTRYPOINT ["tini", "--", "python", "-m", "fsp_eval"]

# Checks run in this image: the same Python, dependencies and font as a run.
FROM runtime AS test
COPY --from=uv /uv /usr/local/bin/uv
RUN --mount=type=cache,id=fsp-eval-uv,target=/root/.cache/uv \
	uv sync --frozen --no-install-project --group dev
COPY tests ./tests
COPY jury ./jury
# Label space of the baselines (skill names, grade order) and the norm table the FSP world is checked against come
# from the application's `taxonomy` build context.
COPY --from=taxonomy skills.json grades.json fsp-strength.json ./tests/taxonomy/
ENTRYPOINT ["tini", "--"]
CMD ["sh", "-c", "ruff check --no-cache src tests && ruff format --no-cache --check src tests && pytest"]
