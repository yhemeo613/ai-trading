export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIResponse {
  content: string;
  provider: string;
  model: string;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface AIProvider {
  name: string;
  isAvailable(): boolean;
  chat(messages: AIMessage[], signal?: AbortSignal): Promise<AIResponse>;
}
