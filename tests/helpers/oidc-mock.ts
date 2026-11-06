// A local OIDC provider for the sso module's tests and e2e (addendum §3): discovery, JWKS, an authorize endpoint
// that approves at once as `mock.user`, and a token endpoint that checks the client secret and PKCE before it
// signs an RS256 ID token. CI needs no provider account. `mock.tamper` breaks one thing on purpose. `mock.okta` mimics
// Okta's org server: `email_verified` is left out of the ID token and served only by userinfo.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export type MockUser = { sub: string; email: string; email_verified?: boolean; hd?: string; amr?: string[] };
type Grant = { clientId: string; redirectUri: string; nonce: string; challenge: string; user: MockUser };

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const body = async (req: IncomingMessage) => {
  let s = '';
  for await (const chunk of req) s += chunk;
  return new URLSearchParams(s);
};

export async function startOidcMock(client = { id: 'mock-client', secret: 'mock-secret' }) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomBytes(4).toString('hex');
  const grants = new Map<string, Grant>();
  const userinfo = new Map<string, MockUser>(); // access token → user
  const mock = {
    issuer: '',
    client,
    user: { sub: 'mock-sub-1', email: 'alice@sso.example', email_verified: true } as MockUser,
    tamper: null as null | 'nonce' | 'aud' | 'signature',
    okta: false,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };

  const idToken = (g: Grant) => {
    const t = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = { iss: mock.issuer, aud: mock.tamper === 'aud' ? 'someone-else' : g.clientId, iat: t, exp: t + 300, nonce: mock.tamper === 'nonce' ? 'wrong' : g.nonce, email_verified: true, ...g.user };
    if (mock.okta) delete claims.email_verified;
    const input = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }))}.${b64(JSON.stringify(claims))}`;
    const sig = sign('sha256', Buffer.from(input), privateKey);
    if (mock.tamper === 'signature') sig[0] = sig[0]! ^ 1;
    return `${input}.${b64(sig)}`;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, mock.issuer);
    const json = (status: number, v: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    if (url.pathname === '/.well-known/openid-configuration')
      return json(200, {
        issuer: mock.issuer,
        authorization_endpoint: `${mock.issuer}/authorize`,
        token_endpoint: `${mock.issuer}/token`,
        jwks_uri: `${mock.issuer}/jwks`,
        userinfo_endpoint: `${mock.issuer}/userinfo`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      });
    if (url.pathname === '/jwks') return json(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] });
    if (url.pathname === '/authorize') {
      const q = url.searchParams;
      if (q.get('client_id') !== client.id || q.get('code_challenge_method') !== 'S256') return json(400, { error: 'invalid_request' });
      const code = randomBytes(16).toString('hex');
      grants.set(code, { clientId: q.get('client_id')!, redirectUri: q.get('redirect_uri')!, nonce: q.get('nonce')!, challenge: q.get('code_challenge')!, user: { ...mock.user } });
      const back = new URL(q.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state')!);
      return res.writeHead(302, { location: back.href }).end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const p = await body(req);
      const basic = req.headers.authorization?.match(/^Basic (.+)$/)?.[1];
      const [id, secret] = basic
        ? Buffer.from(basic, 'base64').toString().split(':').map(decodeURIComponent)
        : [p.get('client_id'), p.get('client_secret')];
      const g = grants.get(p.get('code') ?? '');
      grants.delete(p.get('code') ?? ''); // single use, like a real provider
      if (id !== client.id || secret !== client.secret) return json(401, { error: 'invalid_client' });
      const pkce = g && b64(createHash('sha256').update(p.get('code_verifier') ?? '').digest()) === g.challenge;
      if (!g || !pkce || p.get('redirect_uri') !== g.redirectUri) return json(400, { error: 'invalid_grant' });
      const accessToken = randomBytes(16).toString('hex');
      userinfo.set(accessToken, g.user);
      return json(200, { access_token: accessToken, token_type: 'Bearer', expires_in: 300, id_token: idToken(g) });
    }
    if (url.pathname === '/userinfo') {
      const u = userinfo.get(req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? '');
      return u ? json(200, { email_verified: true, ...u }) : json(401, { error: 'invalid_token' });
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  mock.issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return mock;
}
export type OidcMock = Awaited<ReturnType<typeof startOidcMock>>;
