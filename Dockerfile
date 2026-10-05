# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:24.21.0-trixie-slim

FROM ${NODE_IMAGE} AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
	pnpm install --frozen-lockfile --ignore-scripts --store-dir /pnpm-store

FROM deps AS build
COPY . .
ARG APP_COMMIT
ENV APP_COMMIT=${APP_COMMIT}
# The application, then the worker bundle into build/worker, the demo command line into build/demo, the embedding
# space command line into build/embeddings, the bootstrap administrator's into build/admin and the erasure ledger's into
# build/erasure (after, because the application build empties build/). The demo bundle takes
# the FSP simulator's dataset generator from services/fsp-mock/src.
RUN pnpm build && pnpm exec vite build --config src/worker/bundle.config.ts \
	&& pnpm exec vite build --config src/lib/server/demo/bundle.config.ts \
	&& pnpm exec vite build --config src/lib/server/embeddings/bundle.config.ts \
	&& pnpm exec vite build --config src/lib/server/admin/bootstrap/bundle.config.ts \
	&& pnpm exec vite build --config src/lib/server/erasure/replay/bundle.config.ts

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
	pnpm install --prod --frozen-lockfile --ignore-scripts --store-dir /pnpm-store

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
	HOST=0.0.0.0 \
	PORT=3000 \
	# Resume uploads are limited to 10 MiB (src/lib/server/documents/limits.ts); the extra MiB covers multipart overhead.
	BODY_SIZE_LIMIT=11M
WORKDIR /app
# Application files stay owned by root: the process cannot modify its own code.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY package.json ./
# Scripts run by plain Node (type stripping) next to the server. They import modules of src/ by relative path, so the
# whole source tree comes along (tests are left out by .dockerignore): a script that runs from the repository runs
# here, and a new import needs no line in this file. `pnpm check:image` starts the image to prove it.
COPY scripts/migrate.ts scripts/seed-taxonomy.ts scripts/seed-legal.ts scripts/seed-policies.ts scripts/release-bank.ts ./scripts/
COPY src ./src
COPY taxonomy ./taxonomy
COPY legal ./legal
COPY policies ./policies
COPY assessments ./assessments
# Demo data (docs/deploy.md, «Демо-данные»), read by build/demo/main.js and by the worker's demo.reset from ./seeds.
COPY seeds ./seeds
USER node
EXPOSE 3000
# The worker runs from the same image with its own command (compose.yaml, service `worker`).
# Migrations, the taxonomy release, the legal documents, the product policies with the vacancy sources and the
# releases of the bank of test items are applied on every start; all are idempotent: a taxonomy changed under an
# already published label is refused, a changed legal text becomes a new version, a policy version published with other
# parameters is refused, sources are added disabled, a changed bank becomes a new release only if it passes its checks
# (a bank that does not stays unreleased and its specialization closed; the problems are printed). The embedding space of
# EMBED_SPACE_ID is registered and its `embedding.reindex` enqueued for the worker, which switches search to it once every
# vector is computed; an unknown space id stops the start. The bootstrap administrator of BOOTSTRAP_ADMIN_EMAIL is
# created or confirmed (its password is set only on creation); an address of a demo account or of an account that is
# not active, a weak password, or no BOOTSTRAP_ADMIN_PASSWORD when the account is to be created, stops the start. In
# demonstration mode (DEMO_MODE=true) a stand whose demo data are not of the current batch gets the job demo.reset: the
# worker seeds it (minutes, longer than a deployment waits for the server). The server starts only if all succeed.
CMD ["sh", "-c", "node scripts/migrate.ts && node scripts/seed-taxonomy.ts && node scripts/seed-legal.ts && node scripts/seed-policies.ts && node scripts/release-bank.ts && node build/embeddings/main.js ensure && node build/admin/main.js ensure && if [ \"$DEMO_MODE\" = true ]; then node build/demo/main.js ensure; fi && exec node build/index.js"]
