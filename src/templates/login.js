// Login page template for zylos-recruit.

import { isPathWithinBase } from '../lib/browser-base.js';

const ASSET_VERSION = Date.now();

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function loginPageHtml(baseUrl, error, next) {
  const nextParam = next && isPathWithinBase(next, baseUrl) ? next : '';
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
        <label class="remember-label">
          <input type="checkbox" name="remember"> Remember me
        </label>
        ${nextParam ? `<input type="hidden" name="next" value="${escapeAttr(nextParam)}">` : ''}
        <button type="submit">Sign in</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}
