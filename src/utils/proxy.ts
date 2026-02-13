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
