import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { hashPassword, setupAuth } from '../src/security/auth.js';
import { uiRoute } from '../src/routes/ui.js';
import { chatPageRoute } from '../src/routes/ui-chat.js';

function makeServer() {
  const app = express();
  setupAuth(app, {
    enabled: true,
    password: hashPassword('secret'),
    api_token: 'zr_test_token',
  }, '.');
  app.get('/', uiRoute('.'));
  app.get('/chat/:token', chatPageRoute('..'));

  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

test('login route uses relative paths for stripped proxy and direct local access', async () => {
  const { server, origin } = await makeServer();
  try {
    const root = await fetch(`${origin}/`, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), 'login?next=.%2F');

    const login = await fetch(`${origin}/login?next=.%2F`, {
      redirect: 'manual',
    });
    assert.equal(login.status, 200);
    const body = await login.text();
    assert.match(body, /Zylos Recruit/);
    assert.match(body, /action="\.\/login"/);
    assert.match(body, /href="\.\/_assets\/style\.css/);
  } finally {
    server.close();
  }
});

test('logout redirects to relative login with root next target', async () => {
  const { server, origin } = await makeServer();
  try {
    const stripped = await fetch(`${origin}/logout`, {
      method: 'POST',
      headers: { Origin: origin },
      redirect: 'manual',
    });
    assert.equal(stripped.status, 302);
    assert.equal(stripped.headers.get('location'), 'login?next=.%2F');
  } finally {
    server.close();
  }
});

test('auth redirect next target is relative to the current browser base path', async () => {
  const { server, origin } = await makeServer();
  try {
    const stripped = await fetch(`${origin}/candidates`, { redirect: 'manual' });
    assert.equal(stripped.status, 302);
    assert.equal(stripped.headers.get('location'), 'login?next=candidates');
  } finally {
    server.close();
  }
});

test('x-forwarded-prefix switches browser-facing login paths to proxy prefix', async () => {
  const { server, origin } = await makeServer();
  try {
    const root = await fetch(`${origin}/`, {
      redirect: 'manual',
      headers: { 'X-Forwarded-Prefix': '/recruit' },
    });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/recruit/login?next=%2Frecruit%2F');

    const login = await fetch(`${origin}/login?next=%2Frecruit%2F`, {
      redirect: 'manual',
      headers: { 'X-Forwarded-Prefix': '/recruit' },
    });
    assert.equal(login.status, 200);
    const body = await login.text();
    assert.match(body, /action="\/recruit\/login"/);
    assert.match(body, /href="\/recruit\/_assets\/style\.css/);
  } finally {
    server.close();
  }
});

test('unsafe x-forwarded-prefix falls back to relative local paths', async () => {
  const { server, origin } = await makeServer();
  try {
    const withQuery = await fetch(`${origin}/candidates`, {
      redirect: 'manual',
      headers: { 'X-Forwarded-Prefix': '/recruit?next=//evil.test' },
    });
    assert.equal(withQuery.status, 302);
    assert.equal(withQuery.headers.get('location'), 'login?next=candidates');

    const withHtml = await fetch(`${origin}/login`, {
      redirect: 'manual',
      headers: { 'X-Forwarded-Prefix': '/recruit\"><base href=\"//evil.test/">' },
    });
    assert.equal(withHtml.status, 200);
    const body = await withHtml.text();
    assert.match(body, /action="\.\/login"/);
    assert.doesNotMatch(body, /evil\.test/);
  } finally {
    server.close();
  }
});

test('login next target cannot escape forwarded prefix with dot segments', async () => {
  const { server, origin } = await makeServer();
  try {
    const response = await fetch(`${origin}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Forwarded-Prefix': '/recruit',
      },
      body: new URLSearchParams({
        password: 'secret',
        next: '/recruit/../sensitive',
      }),
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/recruit/');
  } finally {
    server.close();
  }
});

test('ui templates use relative fallback and x-forwarded-prefix browser bases', async () => {
  const { server, origin } = await makeServer();
  try {
    const login = await fetch(`${origin}/login`, {
      method: 'POST',
      body: new URLSearchParams({ password: 'secret' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
    });
    const cookie = login.headers.get('set-cookie');
    assert.ok(cookie);

    const prefixedUi = await fetch(`${origin}/`, {
      redirect: 'manual',
      headers: {
        Cookie: cookie,
        'X-Forwarded-Prefix': '/recruit',
      },
    });
    assert.equal(prefixedUi.status, 200);
    const uiBody = await prefixedUi.text();
    assert.match(uiBody, /action="\/recruit\/logout"/);
    assert.match(uiBody, /data-base-url="\/recruit"/);

    const chat = await fetch(`${origin}/chat/tok`, {
      headers: { 'X-Forwarded-Prefix': '/recruit' },
    });
    assert.equal(chat.status, 200);
    const body = await chat.text();
    assert.match(body, /src="\/recruit\/_assets\/deepChat\.bundle\.js"/);
    assert.match(body, /const BASE_URL = "\/recruit"/);
  } finally {
    server.close();
  }
});
