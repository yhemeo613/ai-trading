import WebSocket from 'ws';
import { logger } from '../utils/logger';

let wss: WebSocket.Server | null = null;

export function initWebSocket(server: any) {
  wss = new WebSocket.Server({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    logger.info('WebSocket client connected');
    ws.on('close', () => logger.info('WebSocket client disconnected'));
  });
  logger.info('WebSocket server initialized on /ws');
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
