// Model prices as data (addendum §6): a price change is one commit here. Integer micro-dollars per million tokens.
// Read from https://platform.claude.com/docs/en/about-claude/pricing on PRICES_AS_OF (footnote's config/prices.json,
// checked 2026-10-19), never from memory. A clone adds its other providers' models to this table.
export const PRICES_AS_OF = '2026-10-19';

// `longPrompt`: above `overInputTokens` the whole call is billed at the higher rates (Haiku 5.5 over 100k prompt tokens).
export type Price = { inputPerMTok: number; outputPerMTok: number; longPrompt?: { overInputTokens: number; inputPerMTok: number; outputPerMTok: number } };

export const PRICES: Readonly<Record<string, Price>> = {
  'anthropic/claude-fable-5-1': { inputPerMTok: 10_000_000, outputPerMTok: 50_000_000 },
  'anthropic/claude-opus-5-5': { inputPerMTok: 4_000_000, outputPerMTok: 20_000_000 },
  'anthropic/claude-sonnet-5-5': { inputPerMTok: 2_000_000, outputPerMTok: 10_000_000 },
  'anthropic/claude-haiku-5-5': { inputPerMTok: 100_000, outputPerMTok: 500_000, longPrompt: { overInputTokens: 100_000, inputPerMTok: 500_000, outputPerMTok: 2_500_000 } },
};

/**
 * Cost of one call in micro-dollars, rounded up so the cap errs toward refusing. Throws on a model with no price:
 * an unpriced call would read as free and never reach the cap.
 * ponytail: all input is priced at the base input rate, so cache reads are over-counted (the safe direction for a cap)
 * and a cache write's premium is under-counted; add cache fields when a clone uses prompt caching with a hard cap.
 */
export function costMicros(provider: string, model: string, inputTokens: number, outputTokens: number): bigint {
  const base = PRICES[`${provider}/${model}`];
  if (!base) throw new Error(`No price for ${provider}/${model} in src/core/ai/prices.ts`);
  const p = base.longPrompt && inputTokens > base.longPrompt.overInputTokens ? base.longPrompt : base;
  const raw = BigInt(inputTokens) * BigInt(p.inputPerMTok) + BigInt(outputTokens) * BigInt(p.outputPerMTok);
  return (raw + 999_999n) / 1_000_000n;
}
