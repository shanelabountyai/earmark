import { z } from 'zod';
import { requireUser, type SessionCtx } from '@/core/auth/session';
import { Refused } from '@/core/errors';
import { requireOrg, type OrgCtx } from './guards';
import type { Permission } from './permissions';

// Every 'use server' export is built by one of these two (spec S2 rule 4): guard first, then parse,
// then the body. The spec rides on the export so the INV-01..04 harness can drive any action with
// no per-action code. Every id field must be `ref('<model>')` so the harness can scope it.

export type ActionSpec =
  | { kind: 'org'; perm: Permission | null; schema: z.ZodType }
  | { kind: 'user'; schema: z.ZodType };
export type Failure = { error: string };

// Forms post FormData; tests and client code may pass a plain object. A name posted twice keeps its last value, as
// it always has (a hidden "0" before a checkbox of the same name relies on that). Opt in to every value with a `[]`
// name: `name="scopes[]"` arrives as `scopes: string[]` (a checkbox group).
export function fields(input: unknown) {
  if (!(input instanceof FormData)) return input;
  const out: Record<string, unknown> = Object.fromEntries([...input].filter(([k]) => !k.endsWith('[]')));
  for (const k of new Set([...input.keys()].filter((k) => k.endsWith('[]')))) out[k.slice(0, -2)] = input.getAll(k);
  return out;
}

async function run<C, S extends z.ZodType, R>(ctx: C, schema: S, input: unknown, fn: (ctx: C, input: z.infer<S>) => Promise<R>) {
  const parsed = schema.safeParse(fields(input));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' } as Failure;
  try {
    return await fn(ctx, parsed.data);
  } catch (e) {
    if (e instanceof Refused) return { error: e.message } as Failure;
    throw e;
  }
}

/** An action inside `/o/[org]`. Bind the slug: `action={renameThing.bind(null, slug)}`. */
export function orgAction<S extends z.ZodType, R>(perm: Permission | null, schema: S, fn: (ctx: OrgCtx, input: z.infer<S>) => Promise<R>) {
  const action = async (orgSlug: string, input: unknown) => run(await requireOrg(orgSlug, perm ?? undefined), schema, input, fn);
  return Object.assign(action, { spec: { kind: 'org', perm, schema } as ActionSpec });
}

/** An action for any signed-in user. Only /login/mfa's own actions pass `allowPendingMfa`. */
export function userAction<S extends z.ZodType, R>(
  schema: S,
  fn: (s: SessionCtx, input: z.infer<S>) => Promise<R>,
  opts: { allowPendingMfa?: boolean } = {},
) {
  const action = async (input: unknown) => run(await requireUser(opts), schema, input, fn);
  return Object.assign(action, { spec: { kind: 'user', schema } as ActionSpec });
}

/** An id of a row the harness must scope: `ref('invite')`. */
export const ref = (model: string) => z.uuid().meta({ ref: model });

/** A field named like an id that is not a row id (an emailed token, a new slug): `notRef(z.string())`. */
export const notRef = <S extends z.ZodType>(s: S) => s.meta({ notRef: true });
