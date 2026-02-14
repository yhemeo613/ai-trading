import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/proxy', () => ({ aiFetch: vi.fn() }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  mockDeepSeek, mockOpenAI, mockAnthropic, mockGemini, mockQwen,
} = vi.hoisted(() => ({
  mockDeepSeek: { name: 'deepseek', isAvailable: vi.fn(() => true), chat: vi.fn() },
  mockOpenAI:   { name: 'openai',   isAvailable: vi.fn(() => true), chat: vi.fn() },
  mockAnthropic:{ name: 'anthropic',isAvailable: vi.fn(() => false),chat: vi.fn() },
  mockGemini:   { name: 'gemini',   isAvailable: vi.fn(() => false),chat: vi.fn() },
  mockQwen:     { name: 'qwen',     isAvailable: vi.fn(() => false),chat: vi.fn() },
}));

vi.mock('../../src/ai/providers/deepseek', () => ({
  DeepSeekProvider: class { name = mockDeepSeek.name; isAvailable = mockDeepSeek.isAvailable; chat = mockDeepSeek.chat; },
}));
vi.mock('../../src/ai/providers/openai', () => ({
  OpenAIProvider: class { name = mockOpenAI.name; isAvailable = mockOpenAI.isAvailable; chat = mockOpenAI.chat; },
}));
vi.mock('../../src/ai/providers/anthropic', () => ({
  AnthropicProvider: class { name = mockAnthropic.name; isAvailable = mockAnthropic.isAvailable; chat = mockAnthropic.chat; },
}));
vi.mock('../../src/ai/providers/gemini', () => ({
  GeminiProvider: class { name = mockGemini.name; isAvailable = mockGemini.isAvailable; chat = mockGemini.chat; },
}));
vi.mock('../../src/ai/providers/qwen', () => ({
  QwenProvider: class { name = mockQwen.name; isAvailable = mockQwen.isAvailable; chat = mockQwen.chat; },
}));

import { aiChat, getAvailableProviders, getProviderStats, resetFailCounts } from '../../src/ai/router';

describe('AI Router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFailCounts();
    mockDeepSeek.isAvailable.mockReturnValue(true);
    mockOpenAI.isAvailable.mockReturnValue(true);
    mockAnthropic.isAvailable.mockReturnValue(false);
    mockGemini.isAvailable.mockReturnValue(false);
    mockQwen.isAvailable.mockReturnValue(false);
  });

  describe('getAvailableProviders', () => {
    it('returns only available providers', () => {
      const available = getAvailableProviders();
      expect(available).toContain('deepseek');
      expect(available).toContain('openai');
      expect(available).not.toContain('anthropic');
    });

    it('returns empty when none available', () => {
      mockDeepSeek.isAvailable.mockReturnValue(false);
      mockOpenAI.isAvailable.mockReturnValue(false);
      expect(getAvailableProviders()).toHaveLength(0);
    });
  });

  describe('aiChat - provider selection', () => {
    it('uses the preferred provider first', async () => {
      const response = { content: 'ok', provider: 'deepseek', model: 'deepseek-chat' };
      mockDeepSeek.chat.mockResolvedValue(response);

      const result = await aiChat([{ role: 'user', content: 'test' }], 'deepseek');
      expect(result).toEqual(response);
      expect(mockDeepSeek.chat).toHaveBeenCalledOnce();
      expect(mockOpenAI.chat).not.toHaveBeenCalled();
    });

    it('uses openai when specified as preferred', async () => {
      const response = { content: 'ok', provider: 'openai', model: 'gpt-4o' };
      mockOpenAI.chat.mockResolvedValue(response);

      const result = await aiChat([{ role: 'user', content: 'test' }], 'openai');
      expect(result).toEqual(response);
      expect(mockOpenAI.chat).toHaveBeenCalledOnce();
    });
  });

  describe('aiChat - fallback on failure', () => {
    it('falls back to next provider when primary fails', async () => {
      mockDeepSeek.chat.mockRejectedValue(new Error('API error'));
      const response = { content: 'fallback ok', provider: 'openai', model: 'gpt-4o' };
      mockOpenAI.chat.mockResolvedValue(response);

      const result = await aiChat([{ role: 'user', content: 'test' }], 'deepseek');
      expect(result).toEqual(response);
      expect(mockDeepSeek.chat).toHaveBeenCalledOnce();
      expect(mockOpenAI.chat).toHaveBeenCalledOnce();
    });

    it('throws when all providers fail', async () => {
      mockDeepSeek.chat.mockRejectedValue(new Error('fail 1'));
      mockOpenAI.chat.mockRejectedValue(new Error('fail 2'));

      await expect(
        aiChat([{ role: 'user', content: 'test' }], 'deepseek'),
      ).rejects.toThrow('所有 AI 提供商均失败');
    });

    it('throws when no providers are available', async () => {
      mockDeepSeek.isAvailable.mockReturnValue(false);
      mockOpenAI.isAvailable.mockReturnValue(false);

      await expect(
        aiChat([{ role: 'user', content: 'test' }]),
      ).rejects.toThrow('没有可用的 AI 提供商');
    });
  });

  describe('aiChat - failure tracking', () => {
    it('increments fail count on failure', async () => {
      mockDeepSeek.chat.mockRejectedValue(new Error('fail'));
      mockOpenAI.chat.mockResolvedValue({ content: 'ok', provider: 'openai', model: 'gpt-4o' });

      await aiChat([{ role: 'user', content: 'test' }], 'deepseek');
      expect(getProviderStats()['deepseek']).toBe(1);
    });

    it('resets fail count on success', async () => {
      mockDeepSeek.chat.mockRejectedValueOnce(new Error('fail'));
      mockOpenAI.chat.mockResolvedValueOnce({ content: 'ok', provider: 'openai', model: 'gpt-4o' });
      await aiChat([{ role: 'user', content: 'test' }], 'deepseek');
      expect(getProviderStats()['deepseek']).toBe(1);

      mockDeepSeek.chat.mockResolvedValueOnce({ content: 'ok', provider: 'deepseek', model: 'deepseek-chat' });
      await aiChat([{ role: 'user', content: 'test' }], 'deepseek');
      expect(getProviderStats()['deepseek']).toBe(0);
    });

    it('accumulates fail counts across calls', async () => {
      mockOpenAI.chat.mockResolvedValue({ content: 'ok', provider: 'openai', model: 'gpt-4o' });

      mockDeepSeek.chat.mockRejectedValueOnce(new Error('fail 1'));
      await aiChat([{ role: 'user', content: 'test' }], 'deepseek');

      mockDeepSeek.chat.mockRejectedValueOnce(new Error('fail 2'));
      await aiChat([{ role: 'user', content: 'test' }], 'deepseek');

      expect(getProviderStats()['deepseek']).toBe(2);
    });
  });

  describe('aiChat - peer provider', () => {
    it('includes peer provider in fallback chain', async () => {
      mockDeepSeek.chat.mockRejectedValue(new Error('fail'));
      mockOpenAI.chat.mockResolvedValue({ content: 'ok', provider: 'openai', model: 'gpt-4o' });

      const result = await aiChat([{ role: 'user', content: 'test' }], 'deepseek', 'openai');
      expect(result.provider).toBe('openai');
    });
  });

  describe('resetFailCounts', () => {
    it('clears all failure counts', async () => {
      mockDeepSeek.chat.mockRejectedValue(new Error('fail'));
      mockOpenAI.chat.mockResolvedValue({ content: 'ok', provider: 'openai', model: 'gpt-4o' });
      await aiChat([{ role: 'user', content: 'test' }], 'deepseek');
      expect(getProviderStats()['deepseek']).toBe(1);

      resetFailCounts();
      expect(getProviderStats()['deepseek']).toBeUndefined();
    });
  });
});
