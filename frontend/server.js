/**
 * OpenShift Cluster Upgrade Calendar - Frontend Server
 * Express + http-proxy-middleware for API proxying
 */
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');

const app = express();
const port = process.env.PORT || 8080;
const backendServiceName = process.env.BACKEND_SERVICE || 'localhost:3000';
// Ensure the target has a protocol prefix — http-proxy-middleware requires it
const backendService = backendServiceName.match(/^https?:\/\//)
  ? backendServiceName
  : `http://${backendServiceName}`;

// Security headers middleware
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// API proxy - forward all /api requests to backend
app.use('/api', createProxyMiddleware({
  target: backendService,
  changeOrigin: true,
  // No WebSocket needed for REST API (removes idle connection timeouts)
  ws: false,
  // Connection timeouts (prevent long hangs on ETIMEDOUT)
  timeout: 30000,
  proxyTimeout: 30000,
  onError: (err, req, res) => {
    console.error('API proxy error:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Bad gateway', message: err.message });
    }
  }
}));

// Health check endpoint - proxy to backend health
app.use('/health', createProxyMiddleware({
  target: backendService,
  changeOrigin: true,
  timeout: 5000,
  onError: (err, req, res) => {
    console.error('Health check proxy error:', err.message);
    if (!res.headersSent) {
      res.status(503).json({ status: 'unhealthy', error: err.message });
    }
  }
}));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1y' : 0,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));

// SPA fallback - return index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err.stack || err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error', details: err.message });
  } else {
    res.end();
  }
});

app.listen(port, () => {
  console.log(`Frontend server listening on port ${port}`);
  console.log(`Proxying API requests to ${backendService}`);
});
