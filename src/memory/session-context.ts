import { insertMemory } from './memory-store';
import { logger } from '../utils/logger';

export type SessionEventType =
  | 'level_test'
  | 'level_break'
  | 'regime_change'
  | 'pattern_detected'
  | 'volume_anomaly'
  | 'narrative_shift';

export interface SessionEvent {
  type: SessionEventType;
  symbol: string;
  timestamp: number;
  description: string;
  price?: number;
  metadata?: Record<string, any>;
}

const MAX_EVENTS_PER_SYMBOL = 30;

// In-memory rolling event buffer per symbol
const eventBuffer: Map<string, SessionEvent[]> = new Map();

// Events important enough to persist to strategy_memory
const PERSIST_TYPES: Set<SessionEventType> = new Set([
  'level_break', 'regime_change', 'narrative_shift',
]);

export function addSessionEvent(event: SessionEvent) {
  const events = eventBuffer.get(event.symbol) ?? [];
  events.push(event);

  // Keep only the most recent events
  if (events.length > MAX_EVENTS_PER_SYMBOL) {
    events.splice(0, events.length - MAX_EVENTS_PER_SYMBOL);
  }
  eventBuffer.set(event.symbol, events);

  // Persist important events to strategy_memory
  if (PERSIST_TYPES.has(event.type)) {
    try {
      insertMemory({
        symbol: event.symbol,
        memoryType: `session_${event.type}`,
        content: event.description,
        marketCondition: event.metadata?.regime ?? undefined,
        relevanceScore: 1.2,
        tags: event.type,
      });
    } catch (err) {
      logger.warn('持久化会话事件失败', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

export function getSessionEvents(symbol: string, limit?: number): SessionEvent[] {
  const events = eventBuffer.get(symbol) ?? [];
  return limit ? events.slice(-limit) : events;
}

export function formatForPrompt(symbol: string): string {
  const events = eventBuffer.get(symbol);
  if (!events || events.length === 0) return '';

  const recent = events.slice(-15);
  const lines = ['【近期市场事件】'];
  for (const e of recent) {
    const time = new Date(e.timestamp).toISOString().slice(11, 19);
    const priceStr = e.price ? ` @ ${e.price}` : '';
    lines.push(`  [${time}] ${e.description}${priceStr}`);
  }
  return lines.join('\n');
}

export function clearSessionEvents(symbol?: string) {
  if (symbol) {
    eventBuffer.delete(symbol);
  } else {
    eventBuffer.clear();
  }
}
