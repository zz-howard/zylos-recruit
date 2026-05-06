// Browser-visible base path helpers for stripped reverse-proxy deployments.

function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0];
  if (typeof value !== 'string') return '';
  return value.split(',')[0].trim();
}

function isSafePathPrefix(prefix) {
  if (!prefix || prefix === '/') return true;
  if (!prefix.startsWith('/')) return false;
  if (prefix.includes('\\') || prefix.includes('://') || /[\x00-\x20?#"'`<>&%]/.test(prefix)) return false;
  try {
    const decoded = decodeURIComponent(prefix);
    if (/[\x00-\x20?#\\"'`<>&]/.test(decoded)) return false;
    return decoded.split('/').every(part => part !== '..' && part !== '.');
  } catch {
    return false;
  }
}

export function isPathWithinBase(path, baseUrl = '') {
  if (!path || typeof path !== 'string') return false;
  if (path.startsWith('//') || path.includes('://') || path.includes('\\')
      || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(path) || /[\x00-\x1f]/.test(path)) {
    return false;
  }
  try {
    const decoded = decodeURIComponent(path);
    const pathPart = decoded.split(/[?#]/, 1)[0];
    if (pathPart !== './' && pathPart.split('/').some(part => part === '..' || part === '.')) return false;
    const parsed = new URL(path, 'https://zylos.local/current/');
    if (parsed.origin !== 'https://zylos.local' || parsed.username || parsed.password) return false;
    if (baseUrl && baseUrl !== '.') {
      return parsed.pathname === baseUrl || parsed.pathname.startsWith(`${baseUrl}/`);
    }
    return true;
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
