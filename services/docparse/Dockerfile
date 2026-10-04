# syntax=docker/dockerfile:1

ARG PYTHON_IMAGE=python:3.13.15-slim-trixie
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.12.18

FROM ${UV_IMAGE} AS uv

# System tools: LibreOffice (RTF, DOC, ODT), Tesseract with Russian and English models, poppler (PDF raster for OCR).
# Packages come from a fixed Debian snapshot, so every build installs the same versions.
FROM ${PYTHON_IMAGE} AS system
ARG DEBIAN_SNAPSHOT=20260924T000000Z
RUN rm -f /etc/apt/sources.list.d/debian.sources \
	&& printf '%s\n' \
		"deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} trixie main" \
		"deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} trixie-updates main" \
		"deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT} trixie-security main" \
		> /etc/apt/sources.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends \
		fonts-dejavu-core \
		libreoffice-writer-nogui \
		poppler-utils \
		tesseract-ocr \
		tesseract-ocr-eng \
		tesseract-ocr-rus \
		tini \
	&& rm -rf /var/lib/apt/lists/* \
	&& fc-cache -f \
	&& useradd --system --uid 10001 --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin docparse
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
RUN --mount=type=cache,id=docparse-uv,target=/root/.cache/uv \
	uv sync --frozen --no-dev --no-install-project --compile-bytecode

FROM system AS runtime
COPY --from=deps /app/.venv /app/.venv
COPY pyproject.toml uv.lock ./
COPY src ./src
# The extractor version changes whenever anything that shapes the result changes: parser code, Python dependencies,
# converter and OCR packages. It is computed here once and read by the service at start.
RUN python -m compileall -q src \
	&& { find src -name '*.py' -print0 | sort -z | xargs -0 sha256sum; \
		sha256sum uv.lock; \
		dpkg-query -W libreoffice-core-nogui libreoffice-writer-nogui tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng poppler-utils; \
	} | sha256sum | cut -c1-12 > /app/build-digest
USER docparse
EXPOSE 8000
ENTRYPOINT ["tini", "--"]
CMD ["uvicorn", "--factory", "docparse.app:create_app", "--host", "0.0.0.0", "--port", "8000", "--no-server-header", "--no-access-log"]

# Checks run in this image: the same Python, dependencies and system tools as in production.
FROM runtime AS test
USER root
COPY --from=uv /uv /usr/local/bin/uv
RUN --mount=type=cache,id=docparse-uv,target=/root/.cache/uv \
	uv sync --frozen --no-install-project --group dev
# The response schema is shared with the application; it comes from the `contracts` build context.
COPY --from=contracts docparse/v1.schema.json ./contracts/docparse/v1.schema.json
COPY tests ./tests
ENV DOCPARSE_SCHEMA_PATH=/app/contracts/docparse/v1.schema.json
USER docparse
ENTRYPOINT ["tini", "--"]
CMD ["sh", "-c", "ruff check --no-cache src tests && ruff format --no-cache --check src tests && pytest"]
