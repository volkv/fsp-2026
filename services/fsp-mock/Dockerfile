# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:24.21.0-trixie-slim

FROM ${NODE_IMAGE} AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /srv
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
	pnpm install --prod --frozen-lockfile --ignore-scripts --store-dir /pnpm-store

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
	HOST=0.0.0.0 \
	PORT=57610
WORKDIR /srv
# Code stays owned by root: the process cannot modify it. TypeScript runs as is (Node strips erasable types).
COPY --from=deps /srv/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER node
EXPOSE 57610
CMD ["node", "src/main.ts"]
