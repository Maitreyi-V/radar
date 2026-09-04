# Single-stage image: this is a modular monolith, so one process serves the API and the
# pre-built frontend. No database container — SQLite lives on a mounted volume.
FROM node:24-slim AS base
WORKDIR /app

# python3/make/g++ are needed to build better-sqlite3's native binding.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY . .

# Build the frontend to static files; the server serves them in production.
RUN npm run build --workspace=apps/web

ENV NODE_ENV=production
ENV PORT=4000
ENV RADAR_DB=/data/radar.db
EXPOSE 4000

# The recorded session is baked into the image at /seed and copied to the volume on
# first boot, so a fresh container still reaches the hero moment with real data.
COPY apps/server/data/radar.db /seed/radar.db
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "start", "--workspace=apps/server"]
