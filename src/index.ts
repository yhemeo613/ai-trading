import express from 'express';
import path from 'path';
import http from 'http';
import { config } from './config';
import { logger } from './utils/logger';
import { getDb, closeDb } from './persistence/db';
import { initWebSocket } from './dashboard/websocket';
import dashboardRoutes from './dashboard/routes';
import { startLoop, stopLoop } from './core/loop';
import { getExchange } from './exchange/client';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'dashboard', 'public')));
app.use(dashboardRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), testnet: config.testnetOnly });
});

const server = http.createServer(app);
initWebSocket(server);

async function boot() {
  logger.info('=== AI USDT Futures Trading Bot ===');
  logger.info(`Mode: ${config.testnetOnly ? 'TESTNET' : 'LIVE'}`);

  // Init database
  getDb();

  // Verify exchange connectivity
  try {
    const ex = getExchange();
    await ex.loadMarkets();
    logger.info(`Exchange connected, ${Object.keys(ex.markets).length} markets loaded`);
  } catch (err: any) {
    logger.error('Exchange connection failed', { error: err.message });
    logger.error('Bot will start but trading may fail until exchange is reachable');
  }

  // Start HTTP server
  server.listen(config.server.port, () => {
    logger.info(`Dashboard: http://localhost:${config.server.port}`);
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${config.server.port} is in use. Dashboard disabled, trading loop continues.`);
    } else {
      logger.error('Server error', { error: err.message });
    }
  });

  // Auto-start trading loop
  startLoop();
}

// Graceful shutdown
function shutdown() {
  logger.info('Shutting down...');
  stopLoop();
  closeDb();
  server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});

boot().catch((err) => {
  logger.error('Boot failed', { error: err.message });
  process.exit(1);
});

export default app;
