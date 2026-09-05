# Multi-stage Dockerfile for slack-llm-runner
# Production image for Linux/Hetzner deployment
# Note: Windows development continues running natively (unaffected by this Dockerfile)

# Stage 1: Builder
# Full Node.js image with compiler toolchain for native module compilation
FROM node:22-bookworm AS builder

WORKDIR /build

# Copy package files
COPY package*.json ./

# Install dependencies (includes native modules: node-pty, better-sqlite3)
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript → dist/
RUN npm run build

# Stage 2: Runtime
# Slim Node.js image without development dependencies
FROM node:22-bookworm-slim

WORKDIR /app

# Copy compiled dist, node_modules with native bindings, config, and package.json from builder
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json

# Copy configuration directory
COPY config ./config

# Install himalaya binary (Rust CLI, not an npm package — installed via its release script)
# Pinned to v2.1.0; keep in sync with docs/development/CLAUDE.md once documented there
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -sSL https://raw.githubusercontent.com/pimalaya/himalaya/v2.1.0/install.sh | PREFIX=/usr/local sh

# Create volume directories for runtime data
RUN mkdir -p /app/data /app/logs

# Health check (optional, helps with orchestration)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('fs').existsSync('/app/dist/index.js') || process.exit(1)"

# Set environment to production
ENV NODE_ENV=production

# Expose for potential future use (not strictly required for CLI app)
EXPOSE 3000

# Volume mount points for persistent data
VOLUME ["/app/config", "/app/data", "/app/logs"]

# Entrypoint: run the application
ENTRYPOINT ["node", "dist/index.js"]
