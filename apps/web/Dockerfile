# CaseGuard AI web image (Next.js App Router, standalone output).
#
# The build context MUST be the repository root:
#   docker build -f apps/web/Dockerfile -t caseguard-web:local .
#   docker run -e API_INTERNAL_URL=http://api:4000 -p 3000:3000 caseguard-web:local
#
# Configuration (important):
#   - Next.js inlines NEXT_PUBLIC_* values into the client bundle, so those are BUILD ARGUMENTS below.
#     Changing them requires rebuilding the image. None of them is a secret (Entra client id, authority
#     and scope are public by design); never pass credentials as build args.
#   - API_INTERNAL_URL (where the web server forwards /api/*, /livez, /healthz and /readyz) is a RUNTIME
#     environment variable read on every request by src/proxy.ts. It is deliberately NOT a build
#     argument and the image has no default for it: when it is missing the web server answers 502
#     (problem+json, code upstream_not_configured) in production instead of forwarding to a wrong host.
#
# Requirements on apps/web/next.config.ts (owned by the web workstream): `output: 'standalone'` and
# `outputFileTracingRoot` set to the monorepo root, so the server entry is
# .next/standalone/apps/web/server.js. The build fails early with an explanation if that is not so.
#
# Hardening notes
#   - The base image is pinned by tag; digest pinning is a tracked follow-up (docs/CI_CD.md).
#   - Runs as the non-root "node" user; only .next/cache is writable.
#   - Authoring note: this file has NOT been built with Docker in the environment where it was written
#     (no daemon available). CI builds this image.

FROM node:24.22.2-trixie-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true \
    HUSKY=0 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN pnpm fetch

FROM fetch AS build
ARG NEXT_PUBLIC_AUTH_MODE=dev
ARG NEXT_PUBLIC_APP_ENV=local
ARG NEXT_PUBLIC_ENTRA_CLIENT_ID=
ARG NEXT_PUBLIC_ENTRA_AUTHORITY=
ARG NEXT_PUBLIC_ENTRA_API_SCOPE=
ARG NEXT_PUBLIC_API_VALIDATION=
ENV NEXT_PUBLIC_AUTH_MODE=${NEXT_PUBLIC_AUTH_MODE} \
    NEXT_PUBLIC_APP_ENV=${NEXT_PUBLIC_APP_ENV} \
    NEXT_PUBLIC_ENTRA_CLIENT_ID=${NEXT_PUBLIC_ENTRA_CLIENT_ID} \
    NEXT_PUBLIC_ENTRA_AUTHORITY=${NEXT_PUBLIC_ENTRA_AUTHORITY} \
    NEXT_PUBLIC_ENTRA_API_SCOPE=${NEXT_PUBLIC_ENTRA_API_SCOPE} \
    NEXT_PUBLIC_API_VALIDATION=${NEXT_PUBLIC_API_VALIDATION}
COPY . .
RUN pnpm install --offline --frozen-lockfile --filter "@caseguard/web..."
# `public/` may legitimately be absent from git (empty directories are not tracked); the runtime
# stage copies it unconditionally.
RUN mkdir -p apps/web/public && pnpm --filter @caseguard/web build
RUN test -f apps/web/.next/standalone/apps/web/server.js || { \
      echo "ERROR: apps/web/.next/standalone/apps/web/server.js not found." >&2; \
      echo "next.config.ts must set output: 'standalone' and outputFileTracingRoot to the repo root." >&2; \
      exit 1; \
    }

FROM node:24.22.2-trixie-slim AS runtime
ARG GIT_COMMIT=unknown
ARG NEXT_PUBLIC_AUTH_MODE=dev
ARG NEXT_PUBLIC_APP_ENV=local
ARG NEXT_PUBLIC_ENTRA_CLIENT_ID=
ARG NEXT_PUBLIC_ENTRA_AUTHORITY=
ARG NEXT_PUBLIC_ENTRA_API_SCOPE=
ARG NEXT_PUBLIC_API_VALIDATION=
# HOSTNAME=0.0.0.0 makes the standalone server listen on every interface; without it Next.js binds
# to the container hostname only and neither the health check nor published ports can reach it.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    GIT_COMMIT=${GIT_COMMIT} \
    NEXT_PUBLIC_AUTH_MODE=${NEXT_PUBLIC_AUTH_MODE} \
    NEXT_PUBLIC_APP_ENV=${NEXT_PUBLIC_APP_ENV} \
    NEXT_PUBLIC_ENTRA_CLIENT_ID=${NEXT_PUBLIC_ENTRA_CLIENT_ID} \
    NEXT_PUBLIC_ENTRA_AUTHORITY=${NEXT_PUBLIC_ENTRA_AUTHORITY} \
    NEXT_PUBLIC_ENTRA_API_SCOPE=${NEXT_PUBLIC_ENTRA_API_SCOPE} \
    NEXT_PUBLIC_API_VALIDATION=${NEXT_PUBLIC_API_VALIDATION}
LABEL org.opencontainers.image.title="caseguard-web" \
      org.opencontainers.image.description="CaseGuard AI web application (synthetic demo data only)" \
      org.opencontainers.image.source="https://github.com/snowjug/CaseGuard-Ai" \
      org.opencontainers.image.revision="${GIT_COMMIT}"
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
RUN mkdir -p apps/web/.next/cache && chown -R node:node apps/web/.next/cache
# Numeric uid/gid of the image's "node" user, so that platforms can verify the container is not root.
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/',{signal:AbortSignal.timeout(4000)}).then((r)=>process.exit(r.status<500?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
