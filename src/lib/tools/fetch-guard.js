/**
 * Guarded HTTP fetch — ported from OpenClaw src/infra/net/fetch-guard.ts
 *
 * SSRF-aware HTTP fetch with:
 *   - DNS pinning (prevent TOCTOU attacks)
 *   - Redirect validation (per-hop SSRF checks)
 *   - Cross-origin header stripping
 *   - Streaming response with byte limits
 *   - Timeout handling
 */

import { Agent as HttpAgent } from 'node:http';
import { fetch as undiciFetch, Agent as UndiciAgent, ProxyAgent } from 'undici';
import {
  resolvePinnedHostname,
  createPinnedLookup,
  isBlockedHostnameOrIp,
  SsrFBlockedError,
} from './ssrf.js';

const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const SAFE_REDIRECT_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-language',
  'user-agent',
  'cache-control',
  'pragma',
]);

/**
 * Fetch a URL with SSRF protection, DNS pinning, and redirect validation.
 *
 * @param {object} params
 * @param {string} params.url
 * @param {number} [params.maxRedirects=3]
 * @param {number} [params.timeoutMs=30000]
 * @param {number} [params.maxBytes]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ response: Response, finalUrl: string, text: string, truncated: boolean, bytesRead: number }>}
 */
export async function fetchWithGuard({
  url,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes,
  signal,
}) {
  let currentUrl = url;
  const visited = new Set();
  let redirectCount = 0;
  let currentHeaders = {
    'User-Agent': DEFAULT_USER_AGENT,
    'Accept': 'text/markdown, text/html;q=0.9, */*;q=0.1',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let dispatcher = null;

  try {
    while (true) {
      // Validate URL
      const parsed = new URL(currentUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new SsrFBlockedError(`SSRF blocked: protocol "${parsed.protocol}" not allowed`);
      }

      // Redirect loop detection
      if (visited.has(currentUrl)) {
        throw new Error(`Redirect loop detected at ${currentUrl}`);
      }
      visited.add(currentUrl);

      // SSRF + DNS pinning
      if (dispatcher) {
        try { dispatcher.close(); } catch {}
        dispatcher = null;
      }
      const pinned = await resolvePinnedHostname(parsed.hostname);
      const lookup = createPinnedLookup(pinned.hostname, pinned.addresses);

      const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
      if (proxy) {
        dispatcher = new ProxyAgent(proxy);
      } else {
        dispatcher = new UndiciAgent({ connect: { lookup } });
      }

      // Fetch with manual redirect mode
      const response = await undiciFetch(currentUrl, {
        method: 'GET',
        headers: currentHeaders,
        redirect: 'manual',
        signal: controller.signal,
        dispatcher,
      });

      // Handle redirects
      if (REDIRECT_STATUSES.has(response.status)) {
        redirectCount++;
        if (redirectCount > maxRedirects) {
          throw new Error(`Too many redirects (max ${maxRedirects})`);
        }

        const location = response.headers.get('location');
        if (!location) {
          throw new Error(`Redirect ${response.status} without Location header`);
        }

        const nextUrl = new URL(location, currentUrl).toString();
        const nextParsed = new URL(nextUrl);

        // Validate redirect target against SSRF
        if (isBlockedHostnameOrIp(nextParsed.hostname)) {
          throw new SsrFBlockedError(
            `SSRF blocked: redirect to "${nextParsed.hostname}" is not allowed`
          );
        }

        // Cross-origin: strip sensitive headers
        if (parsed.origin !== nextParsed.origin) {
          const safeHeaders = {};
          for (const [key, value] of Object.entries(currentHeaders)) {
            if (SAFE_REDIRECT_HEADERS.has(key.toLowerCase())) {
              safeHeaders[key] = value;
            }
          }
          currentHeaders = safeHeaders;
        }

        // Consume response body to release connection
        try { await response.text(); } catch {}

        currentUrl = nextUrl;
        continue;
      }

      // Read response body with byte limit
      const { text, truncated, bytesRead } = await readResponseBody(response, maxBytes);

      return {
        response,
        finalUrl: currentUrl,
        text,
        truncated,
        bytesRead,
      };
    }
  } finally {
    clearTimeout(timeout);
    if (dispatcher) {
      try { dispatcher.close(); } catch {}
    }
  }
}

/**
 * Read response body with optional byte limit via streaming.
 */
async function readResponseBody(response, maxBytes) {
  if (!maxBytes) {
    const text = await response.text();
    return { text, truncated: false, bytesRead: Buffer.byteLength(text, 'utf8') };
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    const bytes = Buffer.byteLength(text, 'utf8');
    return {
      text: bytes > maxBytes ? text.slice(0, maxBytes) : text,
      truncated: bytes > maxBytes,
      bytesRead: Math.min(bytes, maxBytes),
    };
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const chunks = [];
  let bytesRead = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        const excess = bytesRead - maxBytes;
        const trimmed = value.slice(0, value.byteLength - excess);
        chunks.push(decoder.decode(trimmed, { stream: false }));
        truncated = true;
        break;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    try { reader.cancel(); } catch {}
  }

  return { text: chunks.join(''), truncated, bytesRead: Math.min(bytesRead, maxBytes) };
}
