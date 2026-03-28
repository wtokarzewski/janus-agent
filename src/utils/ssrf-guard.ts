/**
 * SSRF guard — block requests to private/internal networks.
 * Used by web_fetch and browser tools before fetching user-provided URLs.
 */

/** IPv4 private/reserved ranges that should never be fetched. */
const BLOCKED_IPV4_RANGES = [
  /^127\./,              // loopback
  /^10\./,               // Class A private
  /^172\.(1[6-9]|2\d|3[01])\./,  // Class B private
  /^192\.168\./,         // Class C private
  /^169\.254\./,         // link-local (AWS metadata etc.)
  /^0\./,                // "this" network
  /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./,  // shared address space (RFC 6598)
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',   // GCP metadata
  'metadata.internal',
]);

/**
 * Check if a URL targets a private/internal network.
 * Returns null if safe, or an error message if blocked.
 */
export function checkSsrf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Invalid URL: ${url}`;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'Only http/https URLs are supported';
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block known internal hostnames
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return `Blocked: ${hostname} is an internal address`;
  }

  // Block IPv6 loopback and private ranges
  const bareIpv6 = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  if (bareIpv6 === '::1' || bareIpv6 === '::') {
    return 'Blocked: IPv6 loopback address';
  }
  if (isBlockedIpv6(bareIpv6)) {
    return `Blocked: ${hostname} is a private/reserved IPv6 address`;
  }

  // Block private IPv4 ranges
  if (BLOCKED_IPV4_RANGES.some(r => r.test(hostname))) {
    return `Blocked: ${hostname} is a private/reserved address`;
  }

  // Block numeric IPs that resolve to 0.0.0.0
  if (hostname === '0.0.0.0') {
    return 'Blocked: 0.0.0.0 is not allowed';
  }

  return null;
}

/** Check if an IPv6 address falls in a blocked range. */
function isBlockedIpv6(addr: string): boolean {
  // Expand :: shorthand minimally — we only need the first group
  const expanded = addr.toLowerCase().replace(/^::/, '0:');
  const firstGroup = expanded.split(':')[0];
  if (!firstGroup) return false;
  const val = parseInt(firstGroup, 16);
  if (isNaN(val)) return false;

  // fc00::/7 — unique local addresses (val & 0xfe00 === 0xfc00 → fc.. and fd..)
  if ((val & 0xfe00) === 0xfc00) return true;
  // fe80::/10 — link-local addresses (val & 0xffc0 === 0xfe80)
  if ((val & 0xffc0) === 0xfe80) return true;
  // ff00::/8 — multicast (val & 0xff00 === 0xff00)
  if ((val & 0xff00) === 0xff00) return true;

  return false;
}
