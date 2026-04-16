import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';

import eventsRouter from './routes/events.js';
import healthRouter from './routes/health.js';
import acmClient from './lib/acmClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Configure logger
const logger = winston.createLogger({
  level: NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'cluster-upgrade-calendar' },
  transports: [
    new winston.transports.Console()
  ]
});

// Request logging middleware
app.use((req, res, next) => {
  logger.debug({
    method: req.method,
    url: req.url,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  next();
});

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false // We'll configure separately if needed
}));

// CORS configuration
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check endpoints (no auth required)
app.use('/health', healthRouter);

// API routes
app.use('/api/events', eventsRouter);

// Serve static frontend files in production
if (NODE_ENV === 'production') {
  const frontendBuildPath = process.env.FRONTEND_BUILD_PATH || path.join(__dirname, '../../frontend');
  app.use(express.static(frontendBuildPath, {
    maxAge: '1d',
    etag: true,
    lastModified: true
  }));

  // SPA fallback - serve index.html for all non-API routes
  app.get('*', (req, res, next) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(frontendBuildPath, 'index.html'));
    } else {
      next();
    }
  });
}

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not found',
    path: req.url
  });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error({
    message: 'Unhandled error',
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method
  });

  res.status(err.status || 500).json({
    success: false,
    error: NODE_ENV === 'production' ? 'Internal server error' : err.message,
    ...(NODE_ENV !== 'production' && { stack: err.stack })
  });
});

// Start server
async function startServer() {
  try {
    // Initialize ACM client
    logger.info('Initializing ACM client...');
    await acmClient.initialize();
    logger.info('ACM client initialized');

    app.listen(PORT, '0.0.0.0', () => {
      logger.info(`Server listening on port ${PORT}`, {
        environment: NODE_ENV,
        port: PORT,
        healthEndpoint: `${process.env.HOST || 'http://localhost'}:${PORT}/health`
      });
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully...');
  process.exit(0);
});

startServer();

export default app;