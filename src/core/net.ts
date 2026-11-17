import { isIP } from 'node:net';
import { Refused } from '@/core/errors';

// Where the server may send a request it was told to send (audit A-01, A-02; v1.6.4). Used by every module that
// fetches a URL an org owner typed: webhook endpoints (apikeys) and the SSO issuer with its discovered endpoints (sso).
//
// An address is classified by its BYTES, never by how it was spelled: `new URL()` rewrites `[::ffff:127.0.0.1]` to
// `[::ffff:7f00:1]`, and a DNS answer can come back in either form, so a pattern on the dotted text never matched a URL.
// IPv6 ranges that carry an IPv4 address (mapped, compatible, NAT64, 6to4, Teredo) are judged by that IPv4 address.
// ponytail: resolve-then-fetch still leaves a DNS-rebinding window of milliseconds; closing it means pinning the
// resolved address into the connection (a custom dispatcher), planned for v1.7.0.

type V4 = [number, number, number, number];

function v4Private([a, b, c]: V4): boolean {
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

function parseV4(s: string): V4 | null {
  if (isIP(s) !== 4) return null;
  return s.split('.').map(Number) as V4;
}

/** The 16 bytes of an IPv6 address, or null. Accepts `::`, a trailing dotted IPv4, and a zone id. */
function parseV6(s: string): number[] | null {
  let addr = s.split('%')[0]!;
  if (isIP(addr) !== 6) return null;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr); // a trailing dotted IPv4 is two hex words
  if (dotted) {
    const v4 = parseV4(dotted[1]!);
    if (!v4) return null;
    addr = `${addr.slice(0, -dotted[1]!.length)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const words = (p: string) => (p ? p.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)) : []);
  const l = words(halves[0]!);
  const r = halves.length === 2 ? words(halves[1]!) : [];
  const all = halves.length === 2 ? [...l, ...Array<number>(8 - l.length - r.length).fill(0), ...r] : l;
  if (all.length !== 8 || all.some((w) => Number.isNaN(w))) return null;
  return all.flatMap((w) => [w >> 8, w & 0xff]);
}

const v4At = (b: number[], i: number): V4 => [b[i]!, b[i + 1]!, b[i + 2]!, b[i + 3]!];

function v6Private(b: number[]): boolean {
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 16) || (zero(0, 15) && b[15] === 1)) return true; // :: and ::1
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4Private(v4At(b, 12)); // ::ffff:0:0/96, IPv4-mapped
  if (zero(0, 12)) return v4Private(v4At(b, 12)); // ::/96, IPv4-compatible (deprecated, still routed by some stacks)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return v4Private(v4At(b, 12)); // 64:ff9b::/96 NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return v4Private(v4At(b, 2)); // 2002::/16, 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return v4Private(v4At(b, 12).map((x) => x ^ 0xff) as V4); // 2001::/32 Teredo (client address, inverted)
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return true; // fec0::/10 site-local (deprecated)
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  return false;
}

/** True for any address a server-side fetch must not reach. Unparseable input counts as private (refuse, don't guess). */
export function isPrivateAddress(ip: string): boolean {
  const s = ip.trim().replace(/^\[|\]$/g, '');
  const v4 = parseV4(s);
  if (v4) return v4Private(v4);
  const v6 = parseV6(s.toLowerCase());
  return v6 ? v6Private(v6) : true;
}

export type Lookup = (host: string) => Promise<readonly { address: string }[]>;

/**
 * Checks a URL the server will fetch: https (or http when `allowHttp`), no credentials, and neither the literal host
 * nor any address it resolves to is private. Returns the normalised URL. `what` names the field in the message.
 */
export async function checkOutboundUrl(raw: string, opts: { lookup: Lookup; allowPrivate?: boolean; allowHttp?: boolean; what?: string }): Promise<string> {
  const what = opts.what ?? 'The endpoint';
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Refused(`${what} must be a URL.`);
  }
  if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:')) throw new Refused(`${what} must be an https URL.`);
  if (url.username || url.password) throw new Refused(`${what} URL must not carry a user name or password.`);
  if (opts.allowPrivate) return url.toString();
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const addrs = host === 'localhost' || host.endsWith('.localhost') ? [{ address: '127.0.0.1' }] : isIP(host) ? [{ address: host }] : await opts.lookup(host).catch(() => []);
  if (!addrs.length) throw new Refused(`${host} does not resolve.`);
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Refused(`${what} must not point at a private address.`);
  return url.toString();
}
