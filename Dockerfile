# syntax=docker/dockerfile:1
# Multi-stage build (docs/08 WP13): bun installs + builds, node:24-slim runs.
# One container serves the SPA, the query/admin API and the tracking endpoints;
# the SQLite file lives on the /data volume.

# ---------------------------------------------------------------- build ----
FROM oven/bun:1-slim AS build
# bun install runs better-sqlite3's gyp step, which needs python even when it
# only detects prebuilds.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Dependency layer: manifests only, so source edits don't re-install.
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/tracker/package.json packages/tracker/
RUN bun install --frozen-lockfile

COPY . .
# Tracker bundles + SPA + bundled server (esbuild, better-sqlite3 external).
RUN bun run build

# Stage better-sqlite3 (plus its build-time header dep) out of bun's store,
# dereferencing symlinks, for the native rebuild below.
RUN cd apps/server && bun -e "\
  const { execSync } = require('child_process'); \
  const path = require('path'); \
  const bsq = path.dirname(require.resolve('better-sqlite3/package.json')); \
  const napi = path.dirname(require.resolve('node-addon-api/package.json', { paths: [bsq] })); \
  execSync('cp -rL ' + bsq + ' /better-sqlite3'); \
  execSync('mkdir -p /better-sqlite3/node_modules'); \
  execSync('cp -rL ' + napi + ' /better-sqlite3/node_modules/node-addon-api');" \
 && test -f /better-sqlite3/lib/index.js

# ------------------------------------------------------------- native ------
# Rebuild the one native module from source against the runtime image's exact
# glibc and Node ABI. The shipped prebuilds want a newer glibc than
# node:24-slim carries, so they are removed — the loader then uses this build.
FROM node:24-slim AS native
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /better-sqlite3
COPY --from=build /better-sqlite3 .
RUN rm -rf prebuilds build \
 && node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --release \
 && rm -rf build/Release/obj.target build/Release/.deps deps node_modules src

# ------------------------------------------------------------- runtime -----
FROM node:24-slim
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/analytics.db \
    GEOIP_MMDB_PATH=/data/dbip-city-lite.mmdb \
    ASSETS_DIR=/app/tracker \
    WEB_DIR=/app/web
WORKDIR /app

COPY --from=build /app/apps/server/dist ./server
COPY --from=build /app/apps/web/dist ./web
COPY --from=build /app/packages/tracker/dist ./tracker
COPY --from=native /better-sqlite3 ./node_modules/better-sqlite3

# Fail the build, not the first boot, if the native binding doesn't load here.
RUN node -e "new (require('better-sqlite3'))(':memory:').close()"

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "server/main.js"]
