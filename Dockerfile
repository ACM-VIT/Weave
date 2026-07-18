# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build

WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci

COPY backend/ ./
RUN npm run build \
    && npm prune --omit=dev \
    && npm cache clean --force


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=5000

WORKDIR /app/backend

COPY --from=build --chown=node:node /app/backend/package.json /app/backend/package-lock.json ./
COPY --from=build --chown=node:node /app/backend/node_modules ./node_modules
COPY --from=build --chown=node:node /app/backend/dist ./dist

# Compiled operational scripts resolve these assets relative to /app/backend.
COPY --chown=node:node database/migrations ./database/migrations
COPY --chown=node:node database/audits ./database/audits

USER node

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 5000}/healthz`).then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "dist/server.js"]
