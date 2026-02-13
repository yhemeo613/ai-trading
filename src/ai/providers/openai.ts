import { AIProvider, AIMessage, AIResponse } from '../provider';
import { config } from '../../config';
import { aiFetch } from '../../utils/proxy';

export class OpenAIProvider implements AIProvider {
  name = 'openai';

  isAvailable(): boolean {
    return !!config.ai.openaiKey;
  }

  async chat(messages: AIMessage[]): Promise<AIResponse> {
    const baseUrl = config.ai.openaiBaseUrl || 'https://api.openai.com/v1';
    const data = await aiFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.ai.openaiKey}`,
      },
      body: JSON.stringify({
        model: config.ai.openaiModel,
        messages,
        temperature: 0.3,
        max_tokens: 2000,
      }),
    });

    return {
      content: data.choices[0].message.content,
      provider: this.name,
      model: config.ai.openaiModel,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
      } : undefined,
    };
  }
}
