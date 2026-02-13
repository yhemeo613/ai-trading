import { AIProvider, AIMessage, AIResponse } from '../provider';
import { config } from '../../config';
import { aiFetch } from '../../utils/proxy';

export class DeepSeekProvider implements AIProvider {
  name = 'deepseek';

  isAvailable(): boolean {
    return !!config.ai.deepseekKey;
  }

  async chat(messages: AIMessage[]): Promise<AIResponse> {
    const data = await aiFetch(`${config.ai.deepseekBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.ai.deepseekKey}`,
      },
      body: JSON.stringify({
        model: config.ai.deepseekModel,
        messages,
        temperature: 0.3,
        max_tokens: 2000,
      }),
    });

    return {
      content: data.choices[0].message.content,
      provider: this.name,
      model: config.ai.deepseekModel,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
      } : undefined,
    };
  }
}
