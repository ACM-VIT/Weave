FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build
RUN npm prune --omit=dev

# Runner stage
FROM node:22-alpine AS runner

WORKDIR /app

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Create a non-root user for security
RUN addgroup -S gh-social && adduser -S gh-social -G gh-social
USER gh-social

ENV NODE_ENV=production
EXPOSE 5000

# Start the main API server
CMD ["node", "dist/server.js"]
