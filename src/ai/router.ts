import { AIProvider, AIMessage, AIResponse } from './provider';
import { config } from '../config';
import { logger } from '../utils/logger';
import { OpenAICompatibleProvider } from './providers/openai-compatible';

const allProviders: AIProvider[] = [
  new OpenAICompatibleProvider({
    name: 'deepseek',
    apiKey: config.ai.deepseekKey,
    baseUrl: config.ai.deepseekBaseUrl,
    model: config.ai.deepseekModel,
  }),
  new OpenAICompatibleProvider({
    name: 'qwen',
    apiKey: config.ai.qwenKey,
    baseUrl: config.ai.qwenBaseUrl,
    model: config.ai.qwenModel,
  }),
];

let failCounts = new Map<string, number>();

function getOrderedProviders(preferredProvider?: string, peerProvider?: string): AIProvider[] {
  const preferred = preferredProvider || config.ai.provider;
  const available = allProviders.filter((p) => p.isAvailable());
  const primary = available.find((p) => p.name === preferred);
  const peer = peerProvider ? available.find((p) => p.name === peerProvider && p.name !== preferred) : undefined;
  const rest = available.filter((p) => p.name !== preferred && p.name !== peerProvider);
  // Sort remaining fallbacks by least failures
  rest.sort((a, b) => (failCounts.get(a.name) ?? 0) - (failCounts.get(b.name) ?? 0));
  const ordered: AIProvider[] = [];
  if (primary) ordered.push(primary);
  if (peer) ordered.push(peer);
  ordered.push(...rest);
  return ordered;
}

export async function aiChat(messages: AIMessage[], preferredProvider?: string, peerProvider?: string, signal?: AbortSignal): Promise<AIResponse> {
  const providers = getOrderedProviders(preferredProvider, peerProvider);
  if (providers.length === 0) {
    throw new Error('没有可用的 AI 提供商，请检查 .env 中的 API 密钥');
  }

  let lastError: Error | undefined;
  for (const provider of providers) {
    // Check abort before trying next provider
    if (signal?.aborted) {
      throw new Error('AI 请求已取消');
    }
    try {
      logger.info(`正在调用 AI 提供商: ${provider.name}`);
      const response = await provider.chat(messages, signal);
      failCounts.set(provider.name, 0);
      return response;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // If aborted, don't try fallback providers — stop immediately
      if (signal?.aborted) {
        throw new Error('AI 请求已取消');
      }
      const count = (failCounts.get(provider.name) ?? 0) + 1;
      failCounts.set(provider.name, count);
      logger.warn(`AI 提供商 ${provider.name} 调用失败 (次数: ${count})`, {
        error: lastError.message,
      });
    }
  }

  throw new Error(`所有 AI 提供商均失败，最后错误: ${lastError?.message}`);
}

export function getAvailableProviders(): string[] {
  return allProviders.filter((p) => p.isAvailable()).map((p) => p.name);
}

export function getProviderStats(): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const [name, count] of failCounts) {
    stats[name] = count;
  }
  return stats;
}

/** Reset failure counts — useful for testing. */
export function resetFailCounts(): void {
  failCounts.clear();
}
