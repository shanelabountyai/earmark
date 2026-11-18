import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { checkOutboundUrl, fetchPinned, isPrivateAddress, resolveOutbound } from '@/core/net';
import { Refused } from '@/core/errors';

// src/core/net.ts (v1.6.4, audit A-01/A-02): an address is private by its bytes, however it is spelled.

describe('isPrivateAddress', () => {
  it.each([
    // IPv4
    '0.0.0.0', '10.1.2.3', '127.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '192.0.0.8', '198.18.0.1', '198.19.255.255', '224.0.0.1', '255.255.255.255',
    // IPv6 proper
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'febf::1', 'fec0::1', 'ff02::1',
    // IPv4 embedded in IPv6, every spelling (A-01)
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::FFFF:7F00:0001', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::ffff:c0a8:1',
    '0:0:0:0:0:ffff:10.0.0.5', '::127.0.0.1', '::a00:5', '64:ff9b::a9fe:a9fe', '64:ff9b::10.0.0.5', '2002:a9fe:a9fe::1',
    '2002:7f00:1::', '2001:0:4136:e378:8000:63bf:80ff:fffe', // Teredo whose client is 127.0.0.1 (inverted)
    '[::ffff:7f00:1]',
    // not an address at all: refuse rather than guess
    'not-an-ip', '1.2.3', '::ffff:999.0.0.1',
  ])('%s is private', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '198.20.0.1', '2606:4700::1111', '::ffff:5db8:d822', '64:ff9b::808:808', '2002:808:808::1'])(
    '%s is public',
    (ip) => expect(isPrivateAddress(ip)).toBe(false),
  );
});

describe('checkOutboundUrl', () => {
  const publicDns = async () => [{ address: '93.184.216.34' }];

  it.each([
    'https://[::ffff:127.0.0.1]/in',
    'https://[::ffff:169.254.169.254]/latest/meta-data/',
    'https://[::ffff:c0a8:1]/in',
    'https://[64:ff9b::a9fe:a9fe]/in',
    'https://[::1]/',
    'https://169.254.169.254/',
    'https://localhost/',
    'https://api.localhost/',
    'https://user:pass@example.com/',
    'http://example.com/',
    'not a url',
  ])('refuses %s', async (url) => {
    await expect(checkOutboundUrl(url, { lookup: publicDns })).rejects.toBeInstanceOf(Refused);
  });

  it('refuses a name whose DNS answer is private in either spelling', async () => {
    await expect(checkOutboundUrl('https://hooks.example.test/', { lookup: async () => [{ address: '::ffff:a9fe:a9fe' }] })).rejects.toBeInstanceOf(Refused);
    await expect(checkOutboundUrl('https://hooks.example.test/', { lookup: async () => [{ address: '93.184.216.34' }, { address: '10.0.0.5' }] })).rejects.toBeInstanceOf(Refused);
    await expect(checkOutboundUrl('https://hooks.example.test/', { lookup: async () => [] })).rejects.toBeInstanceOf(Refused);
  });

  it('accepts a public https URL, and names the field in the message', async () => {
    await expect(checkOutboundUrl('https://hooks.example.test/in', { lookup: publicDns })).resolves.toBe('https://hooks.example.test/in');
    await expect(checkOutboundUrl('https://10.0.0.5/', { lookup: publicDns, what: 'The issuer' })).rejects.toThrow(/^The issuer must not point at a private address/);
  });

  it('allowPrivate and allowHttp lift only what they say', async () => {
    await expect(checkOutboundUrl('http://localhost:4010/in', { lookup: publicDns, allowPrivate: true, allowHttp: true })).resolves.toBe('http://localhost:4010/in');
    await expect(checkOutboundUrl('http://localhost:4010/in', { lookup: publicDns, allowPrivate: true })).rejects.toBeInstanceOf(Refused);
  });
});

// v1.7.0: the address the check judged is the address that is dialled (DNS rebinding).
describe('resolveOutbound and fetchPinned', () => {
  it('pins the first checked address of a name, and nothing for a literal or an allowPrivate URL', async () => {
    const lookup = async () => [{ address: '2606:4700::1111' }, { address: '93.184.216.34' }];
    expect(await resolveOutbound('https://hooks.example.test/in', { lookup })).toEqual({ url: 'https://hooks.example.test/in', pin: { address: '2606:4700::1111', family: 6 } });
    expect((await resolveOutbound('https://93.184.216.34/in', { lookup })).pin).toBeNull();
    expect((await resolveOutbound('http://localhost:4010/in', { lookup, allowPrivate: true, allowHttp: true })).pin).toBeNull();
  });

  it('connects to the pinned address whatever the name resolves to, keeping the name as Host', async () => {
    const seen: { host?: string; body: string; method?: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ host: req.headers.host, body, method: req.method });
        if (req.url === '/empty') return void res.writeHead(204).end();
        res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': ['a=1', 'b=2'] }).end('pong');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      // .invalid never resolves (RFC 2606): reaching the server proves the pin, not DNS, chose the address.
      const res = await fetchPinned(`http://rebind.invalid:${port}/in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"x":1}' }, { address: '127.0.0.1', family: 4 });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('pong');
      expect(res.headers.get('set-cookie')).toBe('a=1, b=2');
      expect(seen[0]).toEqual({ host: `rebind.invalid:${port}`, body: '{"x":1}', method: 'POST' });
      const empty = await fetchPinned(`http://rebind.invalid:${port}/empty`, {}, { address: '127.0.0.1', family: 4 });
      expect([empty.status, empty.body]).toEqual([204, null]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('honours the abort signal', async () => {
    const server = createServer(() => {}); // never answers
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(fetchPinned(`http://rebind.invalid:${port}/`, { signal: AbortSignal.timeout(100) }, { address: '127.0.0.1', family: 4 })).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});
