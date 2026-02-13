import WebSocket from 'ws';
import http from 'http';
import { logger } from '../utils/logger';

let wss: WebSocket.Server | null = null;

export function initWebSocket(server: http.Server) {
  wss = new WebSocket.Server({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    logger.info('WebSocket 客户端已连接');
    ws.on('close', () => logger.info('WebSocket 客户端已断开'));
  });
  logger.info('WebSocket 服务已在 /ws 路径初始化');
}

export function broadcast(data: any) {
  if (!wss) return;
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}
