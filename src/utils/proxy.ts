import http from 'http';
import https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { config } from '../config';

let cachedAgent: HttpsProxyAgent<string> | SocksProxyAgent | undefined;

export function getProxyAgent(): HttpsProxyAgent<string> | SocksProxyAgent | undefined {
  if (cachedAgent) return cachedAgent;
  const proxyUrl = config.proxy.https || config.proxy.http;
  if (!proxyUrl) return undefined;

  if (proxyUrl.startsWith('socks')) {
    cachedAgent = new SocksProxyAgent(proxyUrl);
  } else {
    cachedAgent = new HttpsProxyAgent(proxyUrl);
  }
  return cachedAgent;
}

/**
 * Proxy-aware HTTP fetch for AI providers.
 * Uses Node's http/https modules with the proxy agent.
 */
export async function aiFetch(url: string, options: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<any> {
  const agent = getProxyAgent();
  const parsedUrl = new URL(url);
  const isHttps = parsedUrl.protocol === 'https:';
  const lib = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    // Check if already aborted before starting
    if (options.signal?.aborted) {
      reject(new Error('AI 请求已取消'));
      return;
    }

    const req = lib.request(
      url,
      {
        method: options.method,
        headers: options.headers,
        agent: agent as any,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`无效的 JSON 响应: ${data.slice(0, 200)}`));
          }
        });
      }
    );

    // Listen for abort signal to destroy the in-flight request
    if (options.signal) {
      const onAbort = () => {
        req.destroy();
        reject(new Error('AI 请求已取消'));
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
      // Clean up listener when request completes normally
      req.on('close', () => options.signal!.removeEventListener('abort', onAbort));
    }

    req.on('error', (err) => {
      // Don't report abort-caused errors as unexpected
      if (options.signal?.aborted) {
        reject(new Error('AI 请求已取消'));
      } else {
        reject(err);
      }
    });
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('请求超时 (60秒)'));
    });
    req.write(options.body);
    req.end();
  });
}
