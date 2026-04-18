/**
 * SSRF protection — ported from OpenClaw src/infra/net/ssrf.ts
 *
 * Multi-layer defense against Server-Side Request Forgery:
 *   1. Pre-DNS hostname/IP validation
 *   2. DNS resolution with pinning
 *   3. Post-DNS resolved address validation
 */

import dns from 'node:dns';
import net from 'node:net';

const dnsPromises = dns.promises;

// ── Blocked hostnames ──

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
]);

const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal'];

export function isBlockedHostname(hostname) {
  const h = (hostname || '').toLowerCase().trim();
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  return BLOCKED_HOSTNAME_SUFFIXES.some(s => h.endsWith(s));
}

// ── IPv4 private/special-use ranges ──

const IPV4_BLOCKED_RANGES = [
  { prefix: '0.',        mask: 8  },  // "This host" (RFC 1122)
  { prefix: '10.',       mask: 8  },  // Private (RFC 1918)
  { prefix: '100.64.',   mask: 10 },  // Shared address (RFC 6598)
  { prefix: '127.',      mask: 8  },  // Loopback (RFC 1122)
  { prefix: '169.254.',  mask: 16 },  // Link-local (RFC 3927)
  { prefix: '172.16.',   mask: 12 },  // Private (RFC 1918) — 172.16-31.x.x
  { prefix: '192.0.0.',  mask: 24 },  // IETF Protocol assignments (RFC 6890)
  { prefix: '192.0.2.',  mask: 24 },  // Documentation TEST-NET-1 (RFC 5737)
  { prefix: '192.168.',  mask: 16 },  // Private (RFC 1918)
  { prefix: '198.18.',   mask: 15 },  // Benchmark (RFC 2544)
  { prefix: '198.51.100.', mask: 24 }, // Documentation TEST-NET-2 (RFC 5737)
  { prefix: '203.0.113.',  mask: 24 }, // Documentation TEST-NET-3 (RFC 5737)
  { prefix: '224.',      mask: 4  },  // Multicast (RFC 1112)
  { prefix: '240.',      mask: 4  },  // Reserved (RFC 1112)
  { prefix: '255.255.255.255', mask: 32 }, // Broadcast
];

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isBlockedIpv4(ip) {
  if (!net.isIPv4(ip)) return false;
  const addr = ipv4ToInt(ip);
  for (const range of IPV4_BLOCKED_RANGES) {
    const prefix = ipv4ToInt(range.prefix.replace(/\.$/, '.0').replace(/\.0\.0\.0$/, '.0.0.0'));
    const prefixIp = range.prefix.endsWith('.') ? range.prefix + '0' : range.prefix;
    const prefixParts = prefixIp.split('.').map(Number);
    while (prefixParts.length < 4) prefixParts.push(0);
    const prefixAddr = ((prefixParts[0] << 24) | (prefixParts[1] << 16) | (prefixParts[2] << 8) | prefixParts[3]) >>> 0;
    const mask = range.mask === 0 ? 0 : (~0 << (32 - range.mask)) >>> 0;
    if ((addr & mask) === (prefixAddr & mask)) return true;
  }
  return false;
}

// ── IPv6 blocked ranges ──

function isBlockedIpv6(ip) {
  if (!net.isIPv6(ip)) return false;
  const normalized = normalizeIpv6(ip);
  if (normalized === '::1') return true;                          // Loopback
  if (normalized.startsWith('fe80:')) return true;                 // Link-local
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // Unique local
  if (normalized.startsWith('ff')) return true;                    // Multicast
  if (normalized === '::') return true;                            // Unspecified

  const embedded = extractEmbeddedIpv4(ip);
  if (embedded && isBlockedIpv4(embedded)) return true;

  return false;
}

function normalizeIpv6(ip) {
  return ip.toLowerCase().replace(/^\[|\]$/g, '');
}

function extractEmbeddedIpv4(ipv6) {
  const match = ipv6.match(/:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (match) return match[1];
  const normalized = normalizeIpv6(ipv6);
  if (normalized.startsWith('::ffff:')) {
    const suffix = normalized.slice(7);
    if (net.isIPv4(suffix)) return suffix;
  }
  return null;
}

// ── Combined IP check ──

export function isPrivateIpAddress(address) {
  const addr = (address || '').trim();
  if (net.isIPv4(addr)) return isBlockedIpv4(addr);
  if (net.isIPv6(addr)) return isBlockedIpv6(addr);
  const bracket = addr.replace(/^\[|\]$/g, '');
  if (net.isIPv6(bracket)) return isBlockedIpv6(bracket);
  // Only fail-closed for strings that look like IP addresses but can't be parsed
  // (e.g. octal literals like 0177.0.0.1). Domain names are NOT IPs.
  if (looksLikeIpLiteral(addr)) return true;
  return false;
}

function looksLikeIpLiteral(s) {
  // Starts with a digit and only contains digits/dots — likely IPv4 variant
  if (/^\d[\d.]*$/.test(s)) return true;
  // Contains colons — likely IPv6 variant
  if (s.includes(':')) return true;
  // Hex prefix (0x...) — obfuscated IP
  if (/^0x/i.test(s)) return true;
  return false;
}

export function isBlockedHostnameOrIp(hostname) {
  if (isBlockedHostname(hostname)) return true;
  if (isPrivateIpAddress(hostname)) return true;
  return false;
}

// ── DNS resolution with pinning ──

export class SsrFBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SsrFBlockedError';
  }
}

/**
 * Resolve hostname, validate all resolved addresses, return pinned result.
 * @returns {{ hostname: string, addresses: string[] }}
 */
export async function resolvePinnedHostname(hostname) {
  const h = (hostname || '').toLowerCase().trim();

  // Phase 1: pre-DNS validation
  if (isBlockedHostnameOrIp(h)) {
    throw new SsrFBlockedError(`SSRF blocked: hostname "${h}" is not allowed`);
  }

  // If it's a literal IP, skip DNS
  if (net.isIP(h)) {
    if (isPrivateIpAddress(h)) {
      throw new SsrFBlockedError(`SSRF blocked: IP "${h}" is a private/special-use address`);
    }
    return { hostname: h, addresses: [h] };
  }

  // Phase 2: DNS resolution
  let records;
  try {
    records = await dnsPromises.lookup(h, { all: true });
  } catch (err) {
    throw new Error(`DNS resolution failed for "${h}": ${err.message}`);
  }

  if (!records || records.length === 0) {
    throw new Error(`DNS resolution returned no records for "${h}"`);
  }

  // Phase 3: post-DNS validation — check ALL resolved addresses
  const addresses = [];
  for (const record of records) {
    if (isPrivateIpAddress(record.address)) {
      throw new SsrFBlockedError(
        `SSRF blocked: "${h}" resolved to private address ${record.address}`
      );
    }
    if (!addresses.includes(record.address)) {
      addresses.push(record.address);
    }
  }

  return { hostname: h, addresses };
}

/**
 * Create a pinned DNS lookup function for use with undici.
 * Returns pre-resolved addresses in round-robin order.
 */
export function createPinnedLookup(hostname, addresses) {
  let index = 0;
  return (host, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    if (host.toLowerCase() === hostname.toLowerCase()) {
      const addr = addresses[index % addresses.length];
      index++;
      const family = net.isIPv4(addr) ? 4 : 6;
      if (options?.all) {
        callback(null, addresses.map(a => ({ address: a, family: net.isIPv4(a) ? 4 : 6 })));
      } else {
        callback(null, addr, family);
      }
    } else {
      dns.lookup(host, options, callback);
    }
  };
}
