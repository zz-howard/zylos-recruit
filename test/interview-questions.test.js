import assert from 'node:assert/strict';
import test from 'node:test';

const {
  buildContext,
  buildPrompt,
  normalizeInterviewDuration,
  sanitizeGeneratedHtml,
  cleanGeneratedHtml,
} = await import('../src/lib/interview-questions.js');

const candidate = {
  name: 'Ada',
  source: 'referral',
  state: 'pending',
  brief: 'Built workflow automation.',
  extra_info: '',
  evaluations: [],
};

const company = {
  name: 'Acme',
  profile: { content: 'AI workspace company.' },
  eval_prompt: 'Company values product sense.',
};

const role = {
  name: 'AI Product Engineer',
  description: 'Build agent products.',
  expected_portrait: 'Strong product engineering judgment.',
  eval_prompt: 'Role eval prompt stays in interview context.',
  interview_prompt: 'Ask about agent workflow design tradeoffs.',
};

test('buildContext includes local generation date and role interview prompt ordering', () => {
  const context = buildContext({
    candidate,
    company,
    role,
    customPrompt: 'Focus on migration ability.',
    generatedAt: new Date(2026, 5, 9, 12, 0, 0),
  });

  assert.match(context, /## Generation Context\nToday: 2026-06-09 \(Tuesday\), Q2 2026/);
  assert.match(context, /### Role Evaluation Instructions\nRole eval prompt stays in interview context\./);
  assert.match(context, /## Role Interview Instructions\nAsk about agent workflow design tradeoffs\./);
  assert.match(context, /## Interviewer Preferences For This Generation\nFocus on migration ability\./);
  assert.ok(
    context.indexOf('### Role Evaluation Instructions') < context.indexOf('## Role Interview Instructions'),
  );
  assert.ok(
    context.indexOf('## Role Interview Instructions') < context.indexOf('## Interviewer Preferences For This Generation'),
  );
});

test('buildPrompt includes pre-analysis, capping, tenure, and bridging instructions', () => {
  const prompt30 = buildPrompt('context', { duration: 30 });
  assert.match(prompt30, /structured pre-analysis/i);
  assert.match(prompt30, /at most 8 main questions/);
  assert.match(prompt30, /single tenure exceeds 5 years/);
  assert.match(prompt30, /bridges that experience to the current opportunity/);
  assert.match(prompt30, /Related evaluation dimensions should be merged/);

  const prompt60 = buildPrompt('context', { duration: 60 });
  assert.match(prompt60, /at most 12 main questions/);
});

test('normalizeInterviewDuration maps unsupported values to supported prompt budgets', () => {
  assert.equal(normalizeInterviewDuration(30), 30);
  assert.equal(normalizeInterviewDuration('15'), 30);
  assert.equal(normalizeInterviewDuration(45), 60);
  assert.equal(normalizeInterviewDuration(undefined), 60);
});

test('sanitizeGeneratedHtml removes script tags', () => {
  const input = '<html><head></head><body><p>Hello</p><script>alert("xss")</script></body></html>';
  const result = sanitizeGeneratedHtml(input);
  assert.ok(!result.includes('<script'), 'should not contain <script');
  assert.ok(!result.includes('alert'), 'should not contain alert');
  assert.ok(result.includes('<p>Hello</p>'), 'should preserve content');
});

test('sanitizeGeneratedHtml removes multi-line script blocks', () => {
  const input = '<html><body><script type="text/javascript">\nvar x = 1;\nalert(x);\n</script><p>OK</p></body></html>';
  const result = sanitizeGeneratedHtml(input);
  assert.ok(!result.includes('<script'), 'should not contain <script');
  assert.ok(result.includes('<p>OK</p>'), 'should preserve content');
});

test('sanitizeGeneratedHtml removes on* event handlers', () => {
  const input = '<html><body><img src="x.png" onerror="alert(1)"><div onclick="steal()" class="card">Text</div></body></html>';
  const result = sanitizeGeneratedHtml(input);
  assert.ok(!result.includes('onerror'), 'should not contain onerror');
  assert.ok(!result.includes('onclick'), 'should not contain onclick');
  assert.ok(result.includes('class="card"'), 'should preserve other attributes');
  assert.ok(result.includes('src="x.png"'), 'should preserve src');
});

test('sanitizeGeneratedHtml removes javascript: URLs', () => {
  const input = '<html><body><a href="javascript:alert(1)">Click</a></body></html>';
  const result = sanitizeGeneratedHtml(input);
  assert.ok(!result.includes('javascript:'), 'should not contain javascript: URL');
  assert.ok(result.includes('about:blank'), 'should replace with about:blank');
  assert.ok(result.includes('>Click</a>'), 'should preserve link text');
});

test('cleanGeneratedHtml applies sanitization', () => {
  const input = '<html><head></head><body><p>Content</p><script>document.cookie</script></body></html>';
  const result = cleanGeneratedHtml(input);
  assert.ok(!result.includes('<script'), 'cleanGeneratedHtml should sanitize scripts');
  assert.ok(result.includes('<p>Content</p>'), 'should preserve content');
});
