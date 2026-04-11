// Login page template for zylos-recruit.

const ASSET_VERSION = Date.now();

function isSafeRedirect(p) {
  if (!p || typeof p !== 'string') return false;
  return p.startsWith('/') && !p.startsWith('//') && !p.includes('://')
    && !p.includes('\\') && !/[\x00-\x1f]/.test(p);
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function loginPageHtml(baseUrl, error, next) {
  const nextParam = next && isSafeRedirect(next) ? next : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Login — Zylos Recruit</title>
<link rel="stylesheet" href="${baseUrl}/_assets/style.css?v=${ASSET_VERSION}">
</head>
<body class="login-body">
  <div class="login-container">
    <div class="login-card">
      <h1>Zylos Recruit</h1>
      <p class="login-sub">Applicant Tracking System</p>
      ${error ? `<p class="login-error">${escapeAttr(error)}</p>` : ''}
      <form method="POST" action="${baseUrl}/login">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" autofocus required>
        ${nextParam ? `<input type="hidden" name="next" value="${escapeAttr(nextParam)}">` : ''}
        <button type="submit">Sign in</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}
