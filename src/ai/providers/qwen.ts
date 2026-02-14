import { AIProvider, AIMessage, AIResponse } from '../provider';
import { config } from '../../config';
import { aiFetch } from '../../utils/proxy';

export class QwenProvider implements AIProvider {
  name = 'qwen';

  isAvailable(): boolean {
    return !!config.ai.qwenKey;
  }

  async chat(messages: AIMessage[], signal?: AbortSignal): Promise<AIResponse> {
    const data = await aiFetch(`${config.ai.qwenBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.ai.qwenKey}`,
      },
      body: JSON.stringify({
        model: config.ai.qwenModel,
        messages,
        temperature: 0.3,
        max_tokens: 4000,
      }),
      signal,
    });

    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Qwen 返回空响应');

    return {
      content,
      provider: this.name,
      model: config.ai.qwenModel,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
      } : undefined,
    };
  }
}
