import { afterEach, describe, expect, it, vi } from 'vitest';
import { Refused } from '@/core/errors';
import { claudeDrafter, MODEL } from '@/earmark/explainer';

// The real drafter over fetch (D-31): text blocks only, billed usage passed through, a failed call throws (so withBudget
// releases its hold and records nothing).
afterEach(() => vi.unstubAllGlobals());

const reply = (status: number, body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

describe('claudeDrafter', () => {
  it('joins the text blocks, skips thinking, and reports the billed usage', async () => {
    reply(200, { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: ' Spend ran ahead. ' }], usage: { input_tokens: 120, output_tokens: 80 } });
    const out = await claudeDrafter('k').draft('prompt');
    expect(out).toEqual({ text: 'Spend ran ahead.', usage: { provider: 'anthropic', model: MODEL, inputTokens: 120, outputTokens: 80 } });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(JSON.parse(String(init!.body))).toMatchObject({ model: MODEL, max_tokens: 1000 });
  });

  it('an API error or an empty reply is refused', async () => {
    reply(529, { error: { type: 'overloaded_error' } });
    await expect(claudeDrafter('k').draft('p')).rejects.toBeInstanceOf(Refused);
    reply(200, { content: [], usage: { input_tokens: 1, output_tokens: 0 } });
    await expect(claudeDrafter('k').draft('p')).rejects.toBeInstanceOf(Refused);
  });
});
