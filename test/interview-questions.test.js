import assert from 'node:assert/strict';
import test from 'node:test';

const {
  buildContext,
  buildPrompt,
  normalizeInterviewDuration,
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
