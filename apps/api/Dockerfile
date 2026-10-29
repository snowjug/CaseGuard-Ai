# CaseGuard AI API image (Fastify modular monolith).
#
# The build context MUST be the repository root:
#   docker build -f apps/api/Dockerfile -t caseguard-api:local --build-arg GIT_COMMIT=$(git rev-parse HEAD) .
#
# Stages: base -> fetch (lockfile-only download, cached until the lockfile changes) -> build (tsup
# bundle + production node_modules) -> runtime (non-root, no dev dependencies, no pnpm).
#
# Entry points inside the image (both produced by apps/api/tsup.config.ts):
#   node dist/main.js               the HTTP API (default CMD)
#   node dist/db/migrate-cli.js     apply SQL migrations (used by the migration job; `--status` to report)
#
# Hardening notes
#   - The base image is pinned by tag. Pinning by digest (node:<tag>@sha256:...) is a tracked
#     follow-up (docs/CI_CD.md, "Hardening backlog"); Dependabot proposes tag updates meanwhile.
#   - Writable paths are /app/.data (local PGlite data and local object storage; mount a volume or
#     tmpfs) and /tmp. Everything else is root-owned and read-only for the runtime user, so the image
#     also runs with a read-only root filesystem when DATABASE_URL points at PostgreSQL.
#   - Authoring note: this file has NOT been built with Docker in the environment where it was written
#     (no daemon available). The same pnpm fetch/install/deploy and tsup steps were run outside Docker
#     and the bundled output was started against the deployed node_modules. CI builds this image.

FROM node:24.22.2-trixie-slim AS base
# corepack reads the exact pnpm version from the "packageManager" field of package.json.
# HUSKY=0 stops the root "prepare" script from installing git hooks inside the image build.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true \
    HUSKY=0
RUN corepack enable
WORKDIR /repo

FROM base AS fetch
# Only the lockfile and workspace settings are needed to download packages, so this layer is reused
# until dependencies change, regardless of source edits.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN pnpm fetch

FROM fetch AS build
COPY . .
# One step on purpose: install, bundle, then derive the production-only node_modules from the committed
# lockfile. `deploy` needs injected workspace packages in pnpm 10; `--legacy` is avoided because it
# re-resolves version ranges and so could ship dependency versions that differ from the audited lockfile.
RUN pnpm install --offline --frozen-lockfile --filter "@caseguard/api..." \
    && pnpm --filter @caseguard/api build \
    && npm_config_inject_workspace_packages=true \
       pnpm --filter=@caseguard/api --prod deploy --offline /out/api

FROM node:24.22.2-trixie-slim AS runtime
ARG GIT_COMMIT=unknown
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=4000 \
    GIT_COMMIT=${GIT_COMMIT}
LABEL org.opencontainers.image.title="caseguard-api" \
      org.opencontainers.image.description="CaseGuard AI API (synthetic demo data only)" \
      org.opencontainers.image.source="https://github.com/snowjug/CaseGuard-Ai" \
      org.opencontainers.image.revision="${GIT_COMMIT}"
WORKDIR /app
# Workspace packages are bundled into dist/; only npm dependencies are installed here.
COPY --from=build /out/api/node_modules ./node_modules
# package.json carries "type": "module" (needed to load dist/*.js as ESM) and the package version.
COPY --from=build /repo/apps/api/package.json ./package.json
COPY --from=build /repo/apps/api/dist ./dist
# Synthetic demo data (never real data); read only when DEMO_AUTO_SEED=true.
COPY --from=build /repo/synthetic-data ./synthetic-data
RUN mkdir -p /app/.data && chown node:node /app/.data
# Numeric uid/gid of the image's "node" user, so that platforms can verify the container is not root.
USER 1000:1000
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/livez',{signal:AbortSignal.timeout(4000)}).then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
