# Production Dockerfile for Rota Backend
# Supports both API server and background Queue Worker
FROM node:22-bookworm-slim AS base

# Set production environment
ENV NODE_ENV=production

WORKDIR /app

# Install dependencies with npm clean install
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source and configuration
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY migrations/ ./migrations/

# Run as unprivileged node user
USER node

# Expose HTTP port (configurable via PORT env var)
EXPOSE 3000

# Container liveness check querying lightweight /health/live endpoint
# Uses /health/live to prevent waking serverless databases (Neon) during idle periods
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health/live').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Default command: Start unified combined API + Worker process (recommended for 0.5 vCPU / 1 GB RAM)
# To run standalone API: CMD ["node", "--experimental-strip-types", "src/index.ts"]
# To run standalone Worker: CMD ["node", "--experimental-strip-types", "src/worker.ts"]
CMD ["node", "--experimental-strip-types", "src/combined.ts"]
