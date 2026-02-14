import { AIProvider, AIMessage, AIResponse } from '../provider';
import { config } from '../../config';
import { aiFetch } from '../../utils/proxy';

export class AnthropicProvider implements AIProvider {
  name = 'anthropic';

  isAvailable(): boolean {
    return !!config.ai.anthropicKey;
  }

  async chat(messages: AIMessage[], signal?: AbortSignal): Promise<AIResponse> {
    const systemMsg = messages.find((m) => m.role === 'system')?.content || '';
    const nonSystemMsgs = messages.filter((m) => m.role !== 'system');

    const data = await aiFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.ai.anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.ai.anthropicModel,
        max_tokens: 2000,
        system: systemMsg,
        messages: nonSystemMsgs.map((m) => ({ role: m.role, content: m.content })),
        temperature: 0.3,
      }),
      signal,
    });

    const content = data.content?.[0]?.text;
    if (!content) throw new Error('Anthropic 返回空响应');

    return {
      content,
      provider: this.name,
      model: config.ai.anthropicModel,
      usage: data.usage ? {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
      } : undefined,
    };
  }
}
