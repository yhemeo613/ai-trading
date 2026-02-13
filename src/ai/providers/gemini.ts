import { AIProvider, AIMessage, AIResponse } from '../provider';
import { config } from '../../config';
import { aiFetch } from '../../utils/proxy';

export class GeminiProvider implements AIProvider {
  name = 'gemini';

  isAvailable(): boolean {
    return !!config.ai.geminiKey;
  }

  async chat(messages: AIMessage[]): Promise<AIResponse> {
    const systemMsg = messages.find((m) => m.role === 'system')?.content || '';
    const nonSystemMsgs = messages.filter((m) => m.role !== 'system');

    const contents = nonSystemMsgs.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.ai.geminiModel}:generateContent?key=${config.ai.geminiKey}`;
    const data = await aiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: systemMsg ? { parts: [{ text: systemMsg }] } : undefined,
        contents,
        generationConfig: { temperature: 0.3, maxOutputTokens: 2000 },
      }),
    });

    return {
      content: data.candidates[0].content.parts[0].text,
      provider: this.name,
      model: config.ai.geminiModel,
    };
  }
}
