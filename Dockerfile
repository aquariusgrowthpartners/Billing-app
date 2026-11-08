# Explicit Dockerfile instead of Nixpacks.
#
# Nixpacks kept guessing wrong: it detected pnpm from the lockfile and ran
# `pnpm install`, then saw a root `dist/` and switched to its static-site
# provider — serving the SPA with Caddy and never starting Express. A Dockerfile
# removes the guessing entirely: one runtime, one start command.
FROM node:22-bookworm-slim

# better-sqlite3@13 requires Node >= 22 (its engines field says so). Building
# this image on node:20 produced a runtime segfault (exit 139) in the native
# binding, which is what made demo seeding fail with an opaque "Command failed".
#
# It is also a native module, so it compiles on install.
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

# /app/data is supplied by a Railway Volume at runtime (Railway rejects a
# Dockerfile VOLUME instruction), so just make sure the path exists.
RUN mkdir -p /app/data

# Build the demo database INTO the image. Seeding here, at build time, avoids
# running a child process against a freshly-mounted volume at startup — which
# failed on Railway with an opaque "Command failed". At boot the server just
# copies this file into /app/data.
RUN mkdir -p /app/seed \
 && DEMO_DB=/app/seed/demo.db node server/scripts/seed-demo.js

EXPOSE 4000

CMD ["node", "server/index.js"]
