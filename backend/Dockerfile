# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Add native build dependencies for better-sqlite3 (and clean up after)
RUN apk add --no-cache --virtual .gyp python3 make g++

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --only=production && npm cache clean --force; else npm install --only=production && npm cache clean --force; fi

RUN apk del .gyp

# Production stage
FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    npm_config_loglevel=warn

# Prepare PVC mount and permissions for SQLite
RUN mkdir -p /data && chown node:node /data

WORKDIR /app

# Copy app
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/src ./src

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) =>{process.exit(r.statusCode === 200 ? 0 : 1)})" || exit 1

CMD ["node", "src/index.js"]
