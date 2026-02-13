import express from 'express';
import path from 'path';
import http from 'http';
import { config } from './config';
import { logger } from './utils/logger';
import { getDb, closeDb } from './persistence/db';
import { initWebSocket } from './dashboard/websocket';
import dashboardRoutes from './dashboard/routes';
import { startLoop, stopLoop } from './core/loop';
import { getExchange, getPublicExchange } from './exchange/client';

const app = express();
app.use(express.json());

// Serve dashboard: try src/ first (dev), fallback to dist/ (production)
const publicPathDev = path.join(__dirname, '..', 'src', 'dashboard', 'public');
const publicPathProd = path.join(__dirname, 'dashboard', 'public');
const publicPath = require('fs').existsSync(publicPathDev) ? publicPathDev : publicPathProd;
app.use(express.static(publicPath));
app.use(dashboardRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), testnet: config.testnetOnly });
});

const server = http.createServer(app);
initWebSocket(server);

async function boot() {
  logger.info('=== AI USDT 合约交易机器人 ===');
  logger.info(`模式: ${config.testnetOnly ? '测试网' : '实盘'}`);

  // Init database
  getDb();

  // Verify exchange connectivity (public endpoints don't need API key)
  try {
    const pub = getPublicExchange();
    await pub.loadMarkets();
    logger.info(`交易所已连接，已加载 ${Object.keys(pub.markets).length} 个交易对`);
    // Share markets with authenticated exchange
    const ex = getExchange();
    ex.markets = pub.markets;
    (ex as any).markets_by_id = (pub as any).markets_by_id;
    (ex as any).symbols = (pub as any).symbols;
  } catch (err: any) {
    logger.error('交易所连接失败', { error: err.message });
    logger.error('机器人将启动，但在交易所恢复连接前交易可能失败');
  }

  // Start HTTP server
  server.listen(config.server.port, () => {
    logger.info(`控制面板: http://localhost:${config.server.port}`);
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`端口 ${config.server.port} 已被占用，控制面板已禁用，交易循环继续运行`);
    } else {
      logger.error('服务器错误', { error: err.message });
    }
  });

  // Auto-start trading loop
  startLoop().catch((err) => {
    logger.error('交易循环错误', { error: err.message });
  });
}

// Graceful shutdown
function shutdown() {
  logger.info('正在关闭...');
  stopLoop();
  closeDb();
  server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  logger.error('未捕获的异常', { error: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error('未处理的 Promise 拒绝', { reason: String(reason) });
});

boot().catch((err) => {
  logger.error('启动失败', { error: err.message });
  process.exit(1);
});

export default app;
