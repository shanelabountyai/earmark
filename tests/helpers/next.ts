// next/headers, next/navigation and next/cache, mocked the way Next behaves (spike S2): cookies() reads and
// writes one jar per test, redirect()/notFound() throw. Loaded for every test file (vitest setupFiles).
import { beforeEach, vi } from 'vitest';

export class NavSignal extends Error {
  constructor(readonly kind: 'redirect' | 'notFound', readonly to?: string) {
    super(to ? `${kind} ${to}` : kind);
  }
}

export const jar = new Map<string, string>();
beforeEach(() => jar.clear());

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
// after() runs once the response is sent; here it is dropped, and a test runs the deferred work itself (buildExport).
vi.mock('next/server', async (orig) => ({ ...(await orig<object>()), after: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new NavSignal('redirect', to);
  },
  notFound: () => {
    throw new NavSignal('notFound');
  },
}));
