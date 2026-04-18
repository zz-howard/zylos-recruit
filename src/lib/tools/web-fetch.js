/**
 * web_fetch tool — ported from OpenClaw src/agents/tools/web-fetch.ts
 *
 * Fetches a URL and extracts readable content (HTML → markdown/text).
 * Security: SSRF protection, DNS pinning, content wrapping, size limits.
 *
 * Registered as a function tool in the Responses API — the model can
 * invoke it, and we execute locally and return the result.
 */

import { fetchWithGuard } from './fetch-guard.js';
import { wrapExternalContent, wrapperOverhead } from './external-content.js';
import { SsrFBlockedError } from './ssrf.js';

// ── Configuration ──

const DEFAULT_MAX_CHARS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 750_000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const CACHE_MAX_ENTRIES = 100;
const READABILITY_MAX_HTML_CHARS = 1_000_000;
const READABILITY_MAX_NESTING_DEPTH = 3_000;

// ── In-memory cache ──

const FETCH_CACHE = new Map();

function normalizeCacheKey(value) {
  return value.toLowerCase();
}

function readCache(key) {
  const entry = FETCH_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    FETCH_CACHE.delete(key);
    return null;
  }
  return { value: entry.value, cached: true };
}

function writeCache(key, value, ttlMs = DEFAULT_CACHE_TTL_MS) {
  if (ttlMs <= 0) return;
  if (FETCH_CACHE.size >= CACHE_MAX_ENTRIES) {
    const oldest = FETCH_CACHE.keys().next().value;
    FETCH_CACHE.delete(oldest);
  }
  FETCH_CACHE.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
    insertedAt: Date.now(),
  });
}

// ── Lazy-loaded dependencies ──

let readabilityDeps = null;
let readabilityLoadPromise = null;

async function loadReadabilityDeps() {
  if (readabilityDeps) return readabilityDeps;
  if (readabilityLoadPromise) return readabilityLoadPromise;

  readabilityLoadPromise = (async () => {
    try {
      const [readabilityMod, linkedomMod] = await Promise.all([
        import('@mozilla/readability'),
        import('linkedom'),
      ]);
      readabilityDeps = {
        Readability: readabilityMod.Readability,
        parseHTML: linkedomMod.parseHTML,
      };
      return readabilityDeps;
    } catch (err) {
      readabilityLoadPromise = null;
      console.log(`[web-fetch] Readability not available: ${err.message}`);
      return null;
    }
  })();

  return readabilityLoadPromise;
}

// ── HTML processing utilities ──

function sanitizeHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ''));
}

function normalizeWhitespace(text) {
  return text
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function stripInvisibleUnicode(text) {
  return text.replace(/[\u200b\u200c\u200d\u00ad\ufeff\u2060]/g, '');
}

/**
 * Basic HTML → markdown conversion (regex-based, always works).
 */
function htmlToMarkdown(html) {
  let title = null;
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) title = stripTags(titleMatch[1]).trim();

  let md = sanitizeHtml(html);

  // Links
  md = md.replace(/<a\s[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, label) => `[${stripTags(label).trim()}](${href})`);

  // Headings
  for (let i = 1; i <= 6; i++) {
    const re = new RegExp(`<h${i}[^>]*>([\\s\\S]*?)<\\/h${i}>`, 'gi');
    md = md.replace(re, (_, content) => `\n${'#'.repeat(i)} ${stripTags(content).trim()}\n`);
  }

  // Lists
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, content) => `- ${stripTags(content).trim()}\n`);

  // Breaks and block elements
  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<hr\s*\/?>/gi, '\n---\n');
  md = md.replace(/<\/(p|div|section|article|header|footer|main|aside|blockquote)>/gi, '\n');

  // Strip remaining tags
  md = stripTags(md);

  return { text: normalizeWhitespace(md), title };
}

/**
 * Convert markdown to plain text.
 */
function markdownToText(markdown) {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')                 // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')              // links → label only
    .replace(/```[\s\S]*?```/g, '')                        // code blocks
    .replace(/`([^`]*)`/g, '$1')                           // inline code
    .replace(/^#{1,6}\s+/gm, '')                           // heading prefixes
    .replace(/^[-*+]\s+/gm, '')                            // unordered list prefixes
    .replace(/^\d+\.\s+/gm, '')                            // ordered list prefixes
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * Estimate HTML nesting depth without full DOM parse.
 */
function exceedsEstimatedNestingDepth(html, max) {
  let depth = 0, maxDepth = 0;
  for (let i = 0; i < html.length; i++) {
    if (html.charCodeAt(i) === 60) { // '<'
      if (html.charCodeAt(i + 1) === 47) { // '/'
        depth--;
      } else if (html.charCodeAt(i + 1) !== 33) { // not '!'
        depth++;
        if (depth > maxDepth) maxDepth = depth;
        if (maxDepth > max) return true;
      }
    }
  }
  return false;
}

/**
 * Extract readable content using Mozilla Readability.
 */
async function extractReadableContent(html, url, extractMode) {
  if (html.length > READABILITY_MAX_HTML_CHARS) return null;
  if (exceedsEstimatedNestingDepth(html, READABILITY_MAX_NESTING_DEPTH)) return null;

  const deps = await loadReadabilityDeps();
  if (!deps) return null;

  try {
    const sanitized = sanitizeHtml(html);
    const { document } = deps.parseHTML(sanitized);

    try {
      const base = document.createElement('base');
      base.href = url;
      document.head.appendChild(base);
    } catch {}

    const reader = new deps.Readability(document, { charThreshold: 0 });
    const parsed = reader.parse();
    if (!parsed || (!parsed.content && !parsed.textContent)) return null;

    let text;
    if (extractMode === 'text') {
      text = parsed.textContent || '';
    } else {
      const converted = htmlToMarkdown(parsed.content);
      text = converted.text;
    }

    text = stripInvisibleUnicode(text);
    return text ? { text, title: parsed.title } : null;
  } catch (err) {
    console.log(`[web-fetch] Readability failed: ${err.message}`);
    return null;
  }
}

/**
 * Basic HTML content extraction (fallback when Readability fails).
 */
function extractBasicHtmlContent(html, extractMode) {
  const sanitized = sanitizeHtml(html);
  const { text, title } = htmlToMarkdown(sanitized);
  if (!text) return null;

  let result = text;
  if (extractMode === 'text') {
    result = markdownToText(result);
    result = stripInvisibleUnicode(result);
  }

  return result ? { text: result, title } : null;
}

// ── Truncation + wrapping ──

function truncateText(value, maxChars) {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxChars), truncated: true };
}

function wrapContent(text, maxChars) {
  const overhead = wrapperOverhead(true);
  const budget = maxChars - overhead;
  if (budget <= 0) return { text: '', truncated: true, rawLength: text.length, wrappedLength: 0 };

  const { text: truncated, truncated: wasTruncated } = truncateText(text, budget);
  const wrapped = wrapExternalContent(truncated, { source: 'web_fetch', includeWarning: true });

  return {
    text: wrapped,
    truncated: wasTruncated,
    rawLength: text.length,
    wrappedLength: wrapped.length,
  };
}

// ── Tool definition for Responses API ──

export const WEB_FETCH_TOOL_DEFINITION = {
  type: 'function',
  name: 'web_fetch',
  description: 'Fetch and extract readable content from a URL (HTML → markdown/text). Use for lightweight page access without browser automation. Returns extracted text content from the page.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The HTTP or HTTPS URL to fetch.',
      },
      extract_mode: {
        type: 'string',
        enum: ['markdown', 'text'],
        description: 'Output format: "markdown" preserves formatting, "text" strips to plain text. Default: "markdown".',
      },
      max_chars: {
        type: 'number',
        description: 'Maximum characters to return (100–20000). Default: 20000.',
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
};

// ── Main execution ──

/**
 * Execute the web_fetch tool.
 *
 * @param {object} params
 * @param {string} params.url
 * @param {string} [params.extract_mode='markdown']
 * @param {number} [params.max_chars=20000]
 * @returns {Promise<object>} Tool result payload
 */
export async function executeWebFetch({ url, extract_mode = 'markdown', max_chars }) {
  const extractMode = extract_mode;
  const maxChars = Math.max(100, Math.min(max_chars || DEFAULT_MAX_CHARS, DEFAULT_MAX_CHARS));

  // Validate URL
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `Invalid URL: ${url}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'Invalid URL: must be http or https' };
  }

  // Check cache
  const cacheKey = normalizeCacheKey(`fetch:${url}:${extractMode}:${maxChars}`);
  const cached = readCache(cacheKey);
  if (cached) {
    console.log(`[web-fetch] Cache hit: ${url}`);
    return { ...cached.value, cached: true };
  }

  console.log(`[web-fetch] Fetching: ${url} (mode=${extractMode}, maxChars=${maxChars})`);
  const startTime = Date.now();

  // Fetch with SSRF guard
  let fetchResult;
  try {
    fetchResult = await fetchWithGuard({
      url,
      maxRedirects: DEFAULT_MAX_REDIRECTS,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxBytes: DEFAULT_MAX_RESPONSE_BYTES,
    });
  } catch (err) {
    if (err instanceof SsrFBlockedError) {
      return { error: err.message };
    }
    return { error: `Fetch failed: ${err.message}` };
  }

  const { response, finalUrl, text: rawBody, truncated: bodyTruncated, bytesRead } = fetchResult;

  if (!response.ok) {
    return {
      error: `HTTP ${response.status}`,
      url,
      finalUrl,
      status: response.status,
    };
  }

  // Determine content type
  const contentType = (response.headers.get('content-type') || '')
    .split(';')[0].trim().toLowerCase();

  // Extract content
  let extracted = null;
  let extractor = 'unknown';

  if (contentType === 'text/markdown') {
    // Cloudflare Markdown for Agents — use as-is
    extracted = { text: rawBody, title: undefined };
    extractor = 'cf-markdown';
    if (extractMode === 'text') {
      extracted.text = markdownToText(extracted.text);
    }
  } else if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
    // Try Readability first
    extracted = await extractReadableContent(rawBody, finalUrl, extractMode);
    if (extracted) {
      extractor = 'readability';
    } else {
      // Fallback: basic HTML cleanup
      extracted = extractBasicHtmlContent(rawBody, extractMode);
      if (extracted) extractor = 'basic-html';
    }
  } else if (contentType === 'application/json') {
    try {
      const pretty = JSON.stringify(JSON.parse(rawBody), null, 2);
      extracted = { text: pretty, title: undefined };
      extractor = 'json';
    } catch {
      extracted = { text: rawBody, title: undefined };
      extractor = 'raw';
    }
  } else {
    // Raw text fallback
    extracted = { text: stripTags(rawBody), title: undefined };
    extractor = 'raw';
  }

  if (!extracted || !extracted.text) {
    return {
      error: 'Web fetch extraction failed: no readable content found',
      url,
      finalUrl,
      status: response.status,
      contentType,
    };
  }

  // Wrap content with security markers + truncate
  const wrapped = wrapContent(extracted.text, maxChars);

  const tookMs = Date.now() - startTime;
  const result = {
    url,
    finalUrl,
    status: response.status,
    contentType: contentType || undefined,
    title: extracted.title || undefined,
    extractMode,
    extractor,
    externalContent: { untrusted: true, source: 'web_fetch', wrapped: true },
    truncated: wrapped.truncated || bodyTruncated,
    length: wrapped.wrappedLength,
    rawLength: wrapped.rawLength,
    fetchedAt: new Date().toISOString(),
    tookMs,
    text: wrapped.text,
  };

  console.log(`[web-fetch] Done: ${url} — ${extractor}, ${wrapped.rawLength} chars, ${tookMs}ms`);

  // Cache the result
  writeCache(cacheKey, result);

  return result;
}
