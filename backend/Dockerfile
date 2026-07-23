FROM node:22-alpine AS builder

WORKDIR /app

# The build context is the repository root. Migration SQL and the expected
# schema manifest are runtime inputs for the compiled deployment commands.
COPY backend/package*.json ./
RUN npm ci

# Copy source plus database deployment assets, then prove that the compiled
# image has a complete, internally consistent migration set.
COPY backend/ ./
COPY database/ ./database/
RUN npm run build
RUN node dist/scripts/verify-deployment-assets.js
RUN npm prune --omit=dev

# Runner stage
FROM node:22-alpine AS runner

WORKDIR /app

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/database ./database

RUN node dist/scripts/verify-deployment-assets.js

# Create a non-root user for security
RUN addgroup -S gh-social && adduser -S gh-social -G gh-social
USER gh-social

ENV NODE_ENV=production
EXPOSE 5000

# Start the main API server
CMD ["node", "dist/server.js"]
