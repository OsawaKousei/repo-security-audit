import { AI_BUDGET } from '@repo-sentinel/core'
// Fixed server-side limits; API callers cannot select a model or raise limits.
export const LIMITS = {
  githubRequestMs: 10_000, packageBytes: 256 * 1024, lockBytes: 2 * 1024 * 1024,
  npmMs: 60_000, npmOutputBytes: 2 * 1024 * 1024, findings: 200,
  aiMs: 60_000, aiInputBytes: 32_000, aiRequestBytes: 64_000,
  aiResponseBytes: 128 * 1024, aiOutputTokens: 2048,
  ...AI_BUDGET,
} as const
export const AI_MODEL = 'gpt-5.6-luna'
