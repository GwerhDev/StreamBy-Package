import { promises as dns } from 'dns';
import { isIP } from 'net';

// Whether an address is one StreamBy's server must not be made to reach on someone's behalf: a
// loopback, private, link-local, shared, benchmarking, multicast or reserved one (anything a
// request from the server could use to reach its own network).

const ipv4Parts = (ip: string) => ip.split('.').map(Number);

function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ipv4Parts(ip);
  return a === 0                              // 0.0.0.0/8 ("this" network)
    || a === 10                               // 10.0.0.0/8
    || a === 127                              // 127.0.0.0/8 loopback
    || (a === 100 && b >= 64 && b <= 127)     // 100.64.0.0/10 shared (CGNAT)
    || (a === 169 && b === 254)               // 169.254.0.0/16 link-local (cloud metadata)
    || (a === 172 && b >= 16 && b <= 31)      // 172.16.0.0/12
    || (a === 192 && b === 0 && ipv4Parts(ip)[2] === 0) // 192.0.0.0/24 protocol assignments
    || (a === 192 && b === 168)               // 192.168.0.0/16
    || (a === 198 && (b === 18 || b === 19))  // 198.18.0.0/15 benchmarking
    || a >= 224;                              // 224.0.0.0/4 multicast, and 240.0.0.0/4 reserved
}

// An IPv6 address's 8 groups, expanded (an embedded IPv4 written as dotted quad included).
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase().replace(/%.*$/, '');
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [a, b, c, d] = ipv4Parts(dotted[1]);
    text = text.slice(0, -dotted[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? left.length !== 8 : missing < 0) return null;
  return [...left, ...Array(tail === undefined ? 0 : missing).fill('0'), ...right].map(group => parseInt(group, 16));
}

function isPrivateIpv6(ip: string): boolean {
  const groups = ipv6Groups(ip);
  if (!groups || groups.some(Number.isNaN)) return true; // unreadable: not reached
  if (groups.every(g => g === 0)) return true; // :: unspecified
  if (groups.slice(0, 7).every(g => g === 0) && groups[7] === 1) return true; // ::1 loopback
  // ::ffff:a.b.c.d (IPv4-mapped): judged as the IPv4 address it carries.
  if (groups.slice(0, 5).every(g => g === 0) && groups[5] === 0xffff) {
    return isPrivateIpv4(`${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`);
  }
  return (groups[0] & 0xfe00) === 0xfc00     // fc00::/7 unique local (e.g. fdaa::, Fly's network)
    || (groups[0] & 0xffc0) === 0xfe80      // fe80::/10 link-local
    || (groups[0] & 0xff00) === 0xff00;     // ff00::/8 multicast
}

/** Whether an IP address (v4 or v6) is a local, private or otherwise non-public one. */
export function isPrivateIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');
  if (isIP(bare) === 4) return isPrivateIpv4(bare);
  if (isIP(bare) === 6) return isPrivateIpv6(bare);
  return true;
}

const LOCAL_NAME = /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i;

/** Whether a URL's host, as written, is a local name or a non-public IP address. */
export function isPrivateHostName(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, '');
  return isIP(bare) ? isPrivateIp(bare) : LOCAL_NAME.test(bare);
}

/**
 * Whether a host, resolved now, reaches a non-public address: a name can resolve to one even
 * if it doesn't look like it, and resolve differently later, so it's checked right before each
 * request.
 */
export async function resolvesToPrivateAddress(hostname: string): Promise<boolean> {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (isPrivateHostName(bare)) return true;
  if (isIP(bare)) return false;
  const addresses = await dns.lookup(bare, { all: true });
  return !addresses.length || addresses.some(({ address }) => isPrivateIp(address));
}
