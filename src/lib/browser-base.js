// Browser-visible base path helpers for stripped reverse-proxy deployments.

function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0];
  if (typeof value !== 'string') return '';
  return value.split(',')[0].trim();
}

function isSafePathPrefix(prefix) {
  if (!prefix || prefix === '/') return true;
  if (!prefix.startsWith('/')) return false;
  if (prefix.includes('\\') || prefix.includes('://') || /[\x00-\x1f]/.test(prefix)) return false;
  try {
    const decoded = decodeURIComponent(prefix);
    return decoded.split('/').every(part => part !== '..' && part !== '.');
  } catch {
    return false;
  }
}

export function browserBaseFromRequest(req, fallback = '.') {
  const prefix = firstHeaderValue(req.headers['x-forwarded-prefix']);
  if (!prefix) return fallback;
  if (!isSafePathPrefix(prefix)) return fallback;
  if (prefix === '/') return '';
  return prefix.replace(/\/+$/, '') || '';
}

export function browserPath(baseUrl, path) {
  const cleanPath = String(path).replace(/^\/+/, '');
  if (!baseUrl || baseUrl === '.') return cleanPath;
  return `${baseUrl}/${cleanPath}`;
}

export function browserRoot(baseUrl) {
  if (!baseUrl || baseUrl === '.') return './';
  return `${baseUrl}/`;
}
