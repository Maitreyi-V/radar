# ---------- build stage ----------
# Compilers and dev dependencies live here and never reach the runtime image.
FROM node:24-slim AS build
WORKDIR /app

# better-sqlite3 compiles a native binding, so this stage needs a toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY . .

# Compile the server to plain JS and bundle the frontend to static files, so the runtime
# needs neither a TypeScript loader nor Vite.
RUN npm run build --workspace=apps/server \
 && npm run build --workspace=apps/web

# Drop dev dependencies; the compiled native binding stays.
RUN npm prune --omit=dev

# ---------- runtime stage ----------
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000
ENV RADAR_DB=/data/radar.db

# Only what is needed to run: pruned modules, compiled server, built frontend.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist

# The recorded session is baked in and copied to the volume on first boot, so a fresh
# container still reaches the hero moment with real data.
COPY apps/server/data/radar.db /seed/radar.db
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 4000
WORKDIR /app/apps/server
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
