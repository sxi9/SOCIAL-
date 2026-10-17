# apps/server — ONE image for api, worker, and the run-once migrate service
# (compose overrides the command: dist/api.js | dist/worker.js | dist/db/migrate.js).
# Build context is the REPO ROOT: docker build -f apps/server/Dockerfile .

FROM node:22-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN pnpm install --no-frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN pnpm --filter @socialchat/shared build && pnpm --filter @socialchat/server build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
# v0.8b (API.md §1.69, ADR-020): the running build's git commit, baked at
# build time (docker build --build-arg GIT_COMMIT=$(git rev-parse HEAD) …).
# Empty in dev builds — the admin update banner then says "dev build". The
# container never gets .git or docker.sock; updates run on the host.
ARG GIT_COMMIT=
ENV GIT_COMMIT=$GIT_COMMIT
WORKDIR /app
# Workspace node_modules carry the pnpm symlink layout — copy the whole tree.
COPY --from=build /app /app
WORKDIR /app/apps/server
EXPOSE 3000
CMD ["node", "dist/api.js"]
