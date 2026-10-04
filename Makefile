# Requires Node 24 (see .nvmrc) with corepack-managed pnpm in PATH, and Docker with Compose v2.

.PHONY: up down infra dev worker db-migrate db-seed-taxonomy db-seed-demo demo-reset check-fast check-all check-docparse docparse-lock check-fsp-mock check-sandbox

# Local environment file; created once from the template and never overwritten.
.env:
	cp .env.example .env
	@echo "Created .env from .env.example"

## Build the images and start the whole stack; the app container applies migrations and publishes the taxonomy
## before its server starts, the worker starts after it. Waits until every service is healthy.
up: .env
	APP_COMMIT=$$(git rev-parse --short=12 HEAD) docker compose --profile app up -d --build --wait

## Stop the stack; volumes are kept (docker compose down -v removes them).
down:
	docker compose --profile app down

## Start infrastructure only: Postgres, Redis, the object storage (SeaweedFS), Mailpit, the FSP simulator (fsp-mock),
## docparse and the code sandbox with their gateways, and the embedder (llama.cpp, bge-m3; first start downloads the
## model, 635 MB). For pnpm dev and make worker on the host: EMBED_BASE_URL=http://localhost:57820 in .env.
infra: .env
	docker compose up -d --wait

## Vite dev server on http://localhost:57173 (needs `make infra`, `make db-migrate` and `make db-seed-taxonomy`).
dev: .env
	pnpm dev

## Background worker on the host against the database from .env (needs `make infra` and `make db-migrate`), with the
## job types read from the `worker` service of compose.yaml, so the two never drift apart. State:
## http://127.0.0.1:57310/health. Ctrl+C stops it gracefully.
worker: .env
	pnpm worker $$(grep -oE "'--types=[^']+'" compose.yaml | tr -d "'")

## Apply pending migrations to the database from .env.
db-migrate: .env
	pnpm db:migrate

## Publish the taxonomy release from taxonomy/ to the database from .env; a no-op when nothing changed.
db-seed-taxonomy: .env
	pnpm db:seed-taxonomy

## Demo data of the current batch into the database from .env (DEMO_MODE=true only; needs make infra, db-migrate and
## the reference seeds); a no-op when they are seeded. See docs/development.md, «Демо-данные».
db-seed-demo: .env
	pnpm db:seed-demo

## Empty the database from .env except the reference data, reset the simulator, then seed the demo data again.
demo-reset: .env
	pnpm demo:reset

## Lint, type check and unit tests.
check-fast:
	pnpm check:fast

## The full gate: check-fast, integration tests (the sandbox included), build, e2e, the Docker image build, the docparse
## and fsp-mock checks.
check-all: .env
	pnpm check:all

## docparse: ruff and pytest inside its test image (same system tools as production), without network.
check-docparse:
	pnpm check:docparse

## docparse: re-resolve Python dependencies into services/docparse/uv.lock after editing pyproject.toml.
docparse-lock:
	pnpm docparse:lock

## fsp-mock: type check and tests of the FSP simulator on the host, then its Docker image build.
check-fsp-mock:
	pnpm check:fsp-mock

## Code sandbox: build its image and run the adapter's integration tests against it (verdicts, limits, isolation).
check-sandbox:
	pnpm check:sandbox
