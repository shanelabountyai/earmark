// The explainer's model and its stub's fixed usage (D-07, D-31). Pure, so scripts/seed-demo.ts can import it without
// pulling Next into Playwright's global setup.
export const MODEL = 'claude-haiku-5-5';
export const MAX_OUTPUT = 1_000; // a paragraph, plus Haiku's thinking, which max_tokens also caps

// No key: a canned draft billed at a fixed usage, which is at least any real draft's worst case (500 prompt tokens,
// the full output), so the seed's planted spend makes the fourth draft refuse (PRD §9 step 10).
export const STUB_USAGE = { provider: 'anthropic', model: MODEL, inputTokens: 500, outputTokens: MAX_OUTPUT } as const;
