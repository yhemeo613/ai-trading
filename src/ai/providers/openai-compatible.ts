import { AIProvider, AIMessage, AIResponse } from '../provider';
import { aiFetch } from '../../utils/proxy';

export interface OpenAICompatibleConfig {
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
}

export class OpenAICompatibleProvider implements AIProvider {
  name: string;
  private config: OpenAICompatibleConfig;

  constructor(config: OpenAICompatibleConfig) {
    this.name = config.name;
    this.config = config;
  }

  isAvailable(): boolean {
    return !!this.config.apiKey;
  }

  async chat(messages: AIMessage[], signal?: AbortSignal): Promise<AIResponse> {
    const data = await aiFetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: 0.3,
        max_tokens: this.config.maxTokens ?? 2000,
      }),
      signal,
    });

    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error(`${this.name} 返回空响应`);

    return {
      content,
      provider: this.name,
      model: this.config.model,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
      } : undefined,
    };
  }
}
