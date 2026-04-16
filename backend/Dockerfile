# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies only when needed
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --only=production && npm cache clean --force; else npm install --only=production && npm cache clean --force; fi

# Production stage
FROM node:20-alpine

# Set production environment
ENV NODE_ENV=production \
    PORT=3000 \
    npm_config_loglevel=warn

# Create non-root user with OpenShift-compatible UID (1000)
RUN addgroup -g 1000 -S nodejs && \
    adduser -u 1000 -G nodejs -s /bin/sh -D nodejs

# Create /data with OpenShift-compatible permissions (group writable)
RUN mkdir -p /data && \
    chown -R nodejs:nodejs /data && \
    chmod -R 777 /data && \
    chmod -R g+s /data

WORKDIR /app

# Copy built artifacts from builder
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --chown=nodejs:nodejs src/ ./src/

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) =>{process.exit(r.statusCode === 200 ? 0 : 1)})" || exit 1

# Start the application
CMD ["node", "src/index.js"]
