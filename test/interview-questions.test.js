import assert from 'node:assert/strict';
import test from 'node:test';

import fs from 'node:fs';

const {
  buildContext,
  buildPrompt,
  normalizeInterviewDuration,
  sanitizeGeneratedHtml,
  cleanGeneratedHtml,
  prepareSandboxTemplate,
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
  const input = '<p>Hello</p><script>alert("xss")</script>';
  const result = sanitizeGeneratedHtml(input);
  assert.ok(!result.includes('<script'), 'should not contain <script');
  assert.ok(!result.includes('alert'), 'should not contain alert');
  assert.ok(result.includes('<p>Hello</p>'), 'should preserve content');
});

test('sanitizeGeneratedHtml removes multi-line script blocks', () => {
  const input = '<script type="text/javascript">\nvar x = 1;\nalert(x);\n</script><p>OK</p>';
  const result = sanitizeGeneratedHtml(input);
  assert.ok(!result.includes('<script'), 'should not contain <script');
  assert.ok(result.includes('<p>OK</p>'), 'should preserve content');
});

test('sanitizeGeneratedHtml removes on* event handlers', () => {
  const input = '<img src="x.png" onerror="alert(1)"><div onclick="steal()" class="card">Text</div>';
  const result = sanitizeGeneratedHtml(input);
  assert.ok(!result.includes('onerror'), 'should not contain onerror');
  assert.ok(!result.includes('onclick'), 'should not contain onclick');
  assert.ok(result.includes('class="card"'), 'should preserve other attributes');
});

test('sanitizeGeneratedHtml removes javascript: URLs', () => {
  const input = '<a href="javascript:alert(1)">Click</a>';
  const result = sanitizeGeneratedHtml(input);
  assert.ok(!result.includes('javascript:'), 'should not contain javascript: URL');
  assert.ok(result.includes('>Click</a>'), 'should preserve link text');
});

test('sanitizeGeneratedHtml blocks entity-encoded javascript: URLs', () => {
  const input = '<a href="java&#115;cript:alert(1)">Click</a>';
  const result = sanitizeGeneratedHtml(input);
  assert.ok(!result.includes('javascript'), 'should block entity-encoded javascript:');
});

test('sanitizeGeneratedHtml blocks unquoted javascript: URLs', () => {
  const input = '<a href=javascript:alert(1)>Click</a>';
  const result = sanitizeGeneratedHtml(input);
  assert.ok(!result.includes('javascript'), 'should block unquoted javascript:');
});

test('sanitizeGeneratedHtml strips iframe and srcdoc', () => {
  const input = '<p>Text</p><iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>';
  const result = sanitizeGeneratedHtml(input);
  assert.ok(!result.includes('<iframe'), 'should not contain iframe');
  assert.ok(!result.includes('srcdoc'), 'should not contain srcdoc');
  assert.ok(result.includes('<p>Text</p>'), 'should preserve content');
});

test('sanitizeGeneratedHtml strips object/embed/form tags', () => {
  const input = '<object data="x"><embed src="y"><form action="z"><p>Safe</p></form>';
  const result = sanitizeGeneratedHtml(input);
  assert.ok(!result.includes('<object'), 'should not contain object');
  assert.ok(!result.includes('<embed'), 'should not contain embed');
  assert.ok(!result.includes('<form'), 'should not contain form');
  assert.ok(result.includes('<p>Safe</p>'), 'should preserve content');
});

test('sanitizeGeneratedHtml preserves safe HTML structure', () => {
  const input = '<h1>Title</h1><table><tr><th>Q</th><th>A</th></tr><tr><td>Question 1</td><td>Answer</td></tr></table><ul><li>Item</li></ul>';
  const result = sanitizeGeneratedHtml(input);
  assert.ok(result.includes('<h1>Title</h1>'), 'should preserve headings');
  assert.ok(result.includes('<table>'), 'should preserve tables');
  assert.ok(result.includes('<th>Q</th>'), 'should preserve th');
  assert.ok(result.includes('<ul>'), 'should preserve lists');
});

test('sanitizeGeneratedHtml strips meta http-equiv refresh', () => {
  const input = '<meta http-equiv="refresh" content="0;url=https://attacker.example/phish"><p>Safe</p>';
  const result = sanitizeGeneratedHtml(input);
  assert.ok(!result.includes('http-equiv'), 'should strip http-equiv (content alone is inert)');
  assert.ok(result.includes('<p>Safe</p>'), 'should preserve content');
});

test('cleanGeneratedHtml applies sanitization', () => {
  const input = '<html><head></head><body><p>Content</p><script>document.cookie</script></body></html>';
  const result = cleanGeneratedHtml(input);
  assert.ok(!result.includes('<script'), 'cleanGeneratedHtml should sanitize scripts');
  assert.ok(result.includes('<p>Content</p>'), 'should preserve content');
});

test('prepareSandboxTemplate creates a template file with placeholder', () => {
  const templatePath = prepareSandboxTemplate(999);
  assert.ok(fs.existsSync(templatePath), 'template file should exist');
  const content = fs.readFileSync(templatePath, 'utf8');
  assert.ok(content.includes('<!-- CONTENT_PLACEHOLDER -->'), 'should contain placeholder');
  assert.ok(content.includes('<!DOCTYPE html>'), 'should be a full HTML page');
  assert.ok(content.includes('{{TITLE}}'), 'should have title placeholder');
  fs.unlinkSync(templatePath);
});

test('buildPrompt uses template-edit instructions when templatePath is given', () => {
  const prompt = buildPrompt('context', { duration: 60, templatePath: '/tmp/test.html' });
  assert.match(prompt, /template file at: \/tmp\/test\.html/);
  assert.match(prompt, /CONTENT_PLACEHOLDER/);
  assert.match(prompt, /SINGLE Edit call/);
  assert.ok(!prompt.includes('Return a COMPLETE, self-contained HTML page'), 'should not include direct output instructions');
});

test('buildPrompt uses direct HTML output when no templatePath', () => {
  const prompt = buildPrompt('context', { duration: 60 });
  assert.match(prompt, /Return a COMPLETE, self-contained HTML page/);
  assert.ok(!prompt.includes('template file at:'), 'should not include template-edit instructions');
});
