import type { DiscussionDepth, RoleWeight } from './types';
import { DEFAULT_ROLE_WEIGHTS } from './types';

export interface RoundtableConfig {
  enabled: boolean;
  defaultDepth: DiscussionDepth;
  allowDeepMode: boolean;
  /** Minimum roles that must complete for a round to be valid */
  quorum: number;
  /** Per-role AI call timeout in ms */
  roleTimeoutMs: number;
  /** Chairman AI call timeout in ms */
  chairmanTimeoutMs: number;
  /** Role weights for weighted voting */
  roleWeights: RoleWeight[];
  /** Optional per-role AI provider overrides */
  roleProviders: Record<string, string>;
}

export function getRoundtableConfig(): RoundtableConfig {
  return {
    enabled: (process.env.ROUNDTABLE_ENABLED || 'false').toLowerCase() === 'true',
    defaultDepth: (process.env.ROUNDTABLE_DEPTH as DiscussionDepth) || 'standard',
    allowDeepMode: (process.env.ROUNDTABLE_ALLOW_DEEP || 'false').toLowerCase() === 'true',
    quorum: parseInt(process.env.ROUNDTABLE_QUORUM || '3', 10),
    roleTimeoutMs: parseInt(process.env.ROUNDTABLE_ROLE_TIMEOUT_MS || '30000', 10),
    chairmanTimeoutMs: parseInt(process.env.ROUNDTABLE_CHAIRMAN_TIMEOUT_MS || '30000', 10),
    roleWeights: DEFAULT_ROLE_WEIGHTS,
    roleProviders: parseRoleProviders(),
  };
}

function parseRoleProviders(): Record<string, string> {
  const providers: Record<string, string> = {};
  const raw = process.env.ROUNDTABLE_ROLE_PROVIDERS || '';
  if (!raw) return providers;
  // Format: "chief-strategist:deepseek,technical-analyst:qwen"
  for (const pair of raw.split(',')) {
    const [role, provider] = pair.trim().split(':');
    if (role && provider) {
      providers[role.trim()] = provider.trim();
    }
  }
  return providers;
}
