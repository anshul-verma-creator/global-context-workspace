# ==============================================================================
# Global Context Workspace — Context Server Dockerfile
# Multi-stage build for production-grade, secure container deployment
# ==============================================================================

# Stage 1: Builder
FROM node:22-bookworm-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.16.1 --activate
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy root workspace configurations
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json .npmrc ./

# Copy all package manifests
COPY packages/shared/package.json packages/shared/
COPY packages/protocol/package.json packages/protocol/
COPY packages/database/package.json packages/database/
COPY packages/security/package.json packages/security/
COPY packages/events/package.json packages/events/
COPY packages/steno/package.json packages/steno/
COPY packages/retrieval/package.json packages/retrieval/
COPY packages/context-compiler/package.json packages/context-compiler/
COPY packages/runtime/package.json packages/runtime/
COPY apps/server/package.json apps/server/
COPY apps/mcp/package.json apps/mcp/
COPY apps/vscode-extension/package.json apps/vscode-extension/
COPY packages/e2e-tests/package.json packages/e2e-tests/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code across packages
COPY packages/shared/ packages/shared/
COPY packages/protocol/ packages/protocol/
COPY packages/database/ packages/database/
COPY packages/security/ packages/security/
COPY packages/events/ packages/events/
COPY packages/steno/ packages/steno/
COPY packages/retrieval/ packages/retrieval/
COPY packages/context-compiler/ packages/context-compiler/
COPY packages/runtime/ packages/runtime/
COPY apps/server/ apps/server/

# Build packages and server
RUN pnpm --filter @context-workspace/shared build
RUN pnpm --filter @context-workspace/protocol build
RUN pnpm --filter @context-workspace/database build
RUN pnpm --filter @context-workspace/security build
RUN pnpm --filter @context-workspace/events build
RUN pnpm --filter @context-workspace/steno build
RUN pnpm --filter @context-workspace/retrieval build
RUN pnpm --filter @context-workspace/context-compiler build
RUN pnpm --filter @context-workspace/runtime build
RUN pnpm --filter @context-workspace/server build

# Prune dev dependencies for production
RUN CI=true pnpm prune --prod

# Stage 2: Production Runner
FROM node:22-bookworm-slim AS runner

WORKDIR /app

# Install curl for container healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Run as non-root user
USER node

# Copy built artifacts and production dependencies from builder
COPY --chown=node:node --from=builder /app /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "apps/server/dist/index.js"]
