# Cabo — one container serves the game server (Socket.IO + API) and the built web client.

# ---- build: install everything, build the web client ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/engine/package.json packages/engine/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY packages packages
COPY apps apps
RUN npm run build -w @cabo/web

# ---- runtime: production deps + sources + built client ----
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3101
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/engine/package.json packages/engine/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev && npm cache clean --force
COPY packages/engine/src packages/engine/src
COPY apps/server/src apps/server/src
COPY --from=build /app/apps/web/dist apps/web/dist

USER node
EXPOSE 3101
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO /dev/null http://127.0.0.1:${PORT}/ || exit 1
# node (not npm) as PID 1 so SIGTERM reaches the server's graceful shutdown
CMD ["node", "--import", "tsx", "apps/server/src/main.ts"]
