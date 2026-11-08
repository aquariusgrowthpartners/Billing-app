# Explicit Dockerfile instead of Nixpacks.
#
# Nixpacks kept guessing wrong: it detected pnpm from the lockfile and ran
# `pnpm install`, then saw a root `dist/` and switched to its static-site
# provider — serving the SPA with Caddy and never starting Express. A Dockerfile
# removes the guessing entirely: one runtime, one start command.
FROM node:20-bookworm-slim

# better-sqlite3 is a native module and compiles on install
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# dependencies first so the layer caches across source changes
COPY package.json ./
RUN npm install --include=dev --no-audit --no-fund

# source
COPY . .

# build the SPA (Vite writes to client/dist, which server/index.js serves)
RUN npm run build

ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=0.0.0.0

# the demo/data volume is mounted here at runtime
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 4000

CMD ["node", "server/index.js"]
