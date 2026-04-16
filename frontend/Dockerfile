# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN if [ -f package-lock.json ]; then \
      npm ci --only=production && npm cache clean --force; \
    else \
      npm install --only=production && npm cache clean --force; \
    fi

# Copy source files (including server.js and public)
COPY . .

# Production stage
FROM node:20-alpine

WORKDIR /app

# Set environment
ENV NODE_ENV=production
ENV BACKEND_SERVICE=cluster-upgrade-calendar-backend.open-cluster-management.svc.cluster.local:3000
ENV PORT=8080

# Copy only necessary artifacts from builder
COPY --from=builder /app/server.js ./
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules ./node_modules

# Expose port 8080 (non-privileged port for OpenShift)
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/ || exit 1

# Start server
CMD ["node", "server.js"]
