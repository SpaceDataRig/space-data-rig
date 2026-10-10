# Space Data Rig -- container image.
#
# Packages the whole deterministic pipeline + API into one Node 24 image so the
# rig is "plug-and-play" under WSL2 (OpenRig's supported Windows route) or any
# Docker host. The same image runs two roles via the compose command override:
#   - api        : the Hono dashboard + SSE event stream (port 8787)
#   - sim-runner : the compute-heavy science worker (BLS + injection-recovery)
#
# Build context is the repository root:
#   docker build -f openrig/Dockerfile -t space-data-rig:latest ..

FROM node:24-slim

# Deterministic, quiet installs; tzdata for stable timestamps in bundles.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /app

# Install dependencies first for better layer caching. tsx is a devDependency
# and is required at runtime (we execute TypeScript directly), so install all.
COPY package.json package-lock.json ./
RUN npm ci

# Application source.
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY openrig ./openrig

# Writable output dir for findings, bundles and the snapshot (shared volume).
RUN mkdir -p /app/out && chown -R node:node /app
USER node

EXPOSE 8787

# Default role: the dashboard/API. Compose overrides this for the worker.
CMD ["npm", "run", "api"]
