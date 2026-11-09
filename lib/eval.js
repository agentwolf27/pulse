#!/usr/bin/env node
'use strict';
// Pulse — replay harness. Offline: no network, no model, no real state.
//
// Builds small demo chats in a throwaway PULSE_HOME, runs them through the real hook, the
// analyser (compress → prompt → merge, with a recorded model answer in place of Haiku), the
// statusline, the dashboard's JSON and the menu bar, and checks what each one shows.
//
//   node lib/eval.js --baseline           every demo chat through the analyser; print the cards; check invariants
//   node lib/eval.js --suite health       analyser sign-in / limit errors → "AI paused" everywhere; stale cards
//   node lib/eval.js --suite needs-you    permission prompts, closing questions, AskUserQuestion, blockers
//   node lib/eval.js --suite number       every % names its source; +25 cap; 100% only with evidence; plan numbers unchanged
//   node lib/eval.js --suite modes        talk-only chats show no % in the statusline, dashboard or menu bar
//   node lib/eval.js --suite goal         latest request in the prompt; scope change → new goal + history; 12 words
//   add --keep to leave the temp folder behind for a look
//
// Exit 0 when every check passes.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const SUITE = argv.includes('--baseline') ? 'baseline' : (argv[argv.indexOf('--suite') + 1] || '');

// Everything Pulse writes goes to temp folders. The work folder is separate from PULSE_HOME:
// the dashboard hides sessions whose folder sits inside PULSE_HOME (its own worker).
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-eval-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-eval-work-'));
fs.mkdirSync(path.join(HOME, 'state'), { recursive: true });
fs.mkdirSync(path.join(HOME, 'bin'), { recursive: true });
const NOTIFIED = path.join(HOME, 'notified.txt');
fs.writeFileSync(path.join(HOME, 'bin', 'pulse-notify'), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${NOTIFIED}"\n`, { mode: 0o755 });
Object.assign(process.env, { PULSE_HOME: HOME, PULSE_MENUBAR_OFF: '1', PULSE_AUTOPLAN: 'off' });
delete process.env.ANTHROPIC_API_KEY;
delete process.env.PULSE_NESTED;   // set by `pulse-plan verify`; the hook ignores every event while it is set
let netCalls = 0;
globalThis.fetch = async () => { netCalls++; throw new Error('eval: no network'); };
try { Object.defineProperty(process.stdout, 'isTTY', { value: false }); } catch {}   // keep the analyser's log off the terminal

const A = require('./analyze.js');
const D = require('./dash.js');
const resolve = cwd => (cwd && cwd.startsWith(WORK) && fs.existsSync(cwd) ? { root: cwd, name: path.basename(cwd), git: false } : null);

// ---------------------------------------------------------------- fixtures
let seq = 0;
const T0 = Date.now() - 30 * 60 * 1000;
const at = () => new Date(T0 + (seq++) * 1000).toISOString();
const rec = {
  user: text => ({ type: 'user', timestamp: at(), message: { role: 'user', content: text } }),
  say: text => ({ type: 'assistant', timestamp: at(), message: { role: 'assistant', content: [{ type: 'text', text }] } }),
  tool: (id, name, input) => ({ type: 'assistant', timestamp: at(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }),
  result: (id, text) => ({ type: 'user', timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } }),
};
function chat(name) {
  const cwd = path.join(WORK, name);
  fs.mkdirSync(cwd, { recursive: true });
  return { name, sid: `eval-${name}`, cwd, tp: path.join(cwd, 'transcript.jsonl') };
}
function append(c, ...records) { fs.appendFileSync(c.tp, records.map(r => JSON.stringify(r)).join('\n') + '\n'); }
const stateFile = c => path.join(HOME, 'state', `${c.sid}.json`);
const readState = c => JSON.parse(fs.readFileSync(stateFile(c), 'utf8'));
function editState(c, fn) { const s = readState(c); fn(s); fs.writeFileSync(stateFile(c), JSON.stringify(s)); }

const env = { ...process.env, PULSE_HOME: HOME, PULSE_MENUBAR_OFF: '1' };
function hook(c, event, extra = {}) {
  const input = { hook_event_name: event, session_id: c.sid, transcript_path: c.tp, cwd: c.cwd, ...extra };
  const r = spawnSync('bash', [path.join(REPO, 'bin', 'pulse-hook')], { input: JSON.stringify(input), env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`pulse-hook ${event} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}
const plain = s => String(s).replace(/\x1b\[[0-9;]*m/g, '');
function statusline(c) {
  const r = spawnSync('bash', [path.join(REPO, 'bin', 'pulse-status')], { input: JSON.stringify({ session_id: c.sid }), env, encoding: 'utf8' });
  return plain(r.stdout);
}
function dashboard() { return D.payload(D.readSessions(), resolve); }
function menubar(payload) {
  const f = path.join(HOME, 'api.json');
  fs.writeFileSync(f, JSON.stringify(payload));
  const r = spawnSync('bash', [path.join(REPO, 'menubar', 'pulse.5s.sh')], { env: { ...env, PULSE_API_JSON: f }, encoding: 'utf8' });
  return r.stdout;
}
const answer = j => async () => ({ json: j, cost: 0, backend: 'cli', ms: 1, tokens: { in: 0, out: 0 } });
const failing = msg => async () => { throw new Error(msg); };
const notified = () => { try { return fs.readFileSync(NOTIFIED, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 2000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(50); } return fn(); }

// ---------------------------------------------------------------- checks
let pass = 0, fail = 0;
function check(name, ok, got) {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${got !== undefined ? `\n      got: ${typeof got === 'string' ? got : JSON.stringify(got)}` : ''}`); }
}
const has = (hay, needle) => String(hay).includes(needle);

// A demo build chat: a prompt, some edits, a passing test run, a summary.
function buildChat(name, prompt, closing) {
  const c = chat(name);
  append(c,
    rec.user(prompt),
    rec.tool(`${name}-1`, 'Read', { file_path: `${c.cwd}/src/app.js` }), rec.result(`${name}-1`, 'export function app() {}'),
    rec.tool(`${name}-2`, 'Edit', { file_path: `${c.cwd}/src/app.js` }), rec.result(`${name}-2`, 'ok'),
    rec.tool(`${name}-3`, 'Bash', { command: 'npm test' }), rec.result(`${name}-3`, '12 passing, 0 failed'),
    rec.say(closing));
  hook(c, 'UserPromptSubmit', { prompt });
  hook(c, 'Stop');
  return c;
}

// ---------------------------------------------------------------- suites
async function baseline() {
  const cases = [
    { c: buildChat('demo-shop', 'add a cart page with a running total', 'The cart page shows items and a running total. Tests pass.'),
      j: { goal: 'Cart page with running total', mode: 'build', now: 'Cart page renders with totals', done: false, scope_changed: false, blockers: [],
           phases: [{ name: 'Cart model', pct: 100, weight: 2 }, { name: 'Cart page', pct: 70, weight: 3 }, { name: 'Tests', pct: 50, weight: 1 }] } },
    { c: buildChat('demo-notes', 'fix the crash when a note has no title', 'Fixed: an untitled note now falls back to its first line.'),
      j: { goal: 'Fix crash on untitled notes', mode: 'fix', now: 'Fallback title in place', done: true, scope_changed: false, blockers: [],
           phases: [{ name: 'Reproduce', pct: 100, weight: 1 }, { name: 'Fix', pct: 100, weight: 2 }] } },
    { c: buildChat('demo-blog', 'how does the image pipeline work here?', 'Images go through a resize step, then a CDN upload.'),
      j: { goal: 'Understand the image pipeline', mode: 'explore', now: 'Reading the resize step', done: false, scope_changed: false, blockers: [], phases: [] } },
    { c: buildChat('demo-api', 'wire the payments webhook', 'The webhook handler is in, but it cannot be tested yet.'),
      j: { goal: 'Payments webhook handler', mode: 'build', now: 'Handler written, untested', done: false, scope_changed: false,
           blockers: ['no sandbox signing secret', 'webhook URL not registered', 'staging is down', 'a fourth one that must be dropped'],
           phases: Array.from({ length: 8 }, (_, i) => ({ name: `Step ${i + 1}`, pct: i < 3 ? 100 : 0, weight: 1 })) } },
  ];
  const rows = [];
  for (const { c, j } of cases) {
    const text = fs.readFileSync(c.tp, 'utf8');
    const turns = A.compress(text).turns;
    const ok = await A.analyzeOnce(c.sid, c.tp, { model: answer(j), force: true });
    const s = readState(c);
    rows.push({ chat: c.name, turns: turns.length, ok, overall: s.overall, source: s.source, mode: s.mode, health: s.health.state, phases: s.phases.length, blockers: s.blockers.length, now: A.clip(s.now, 34) });
    check(`${c.name}: analysed`, ok === true);
    check(`${c.name}: overall within 0–100`, s.overall >= 0 && s.overall <= 100, s.overall);
    check(`${c.name}: at most 6 phases`, s.phases.length <= 6, s.phases.length);
    check(`${c.name}: at most 3 blockers`, s.blockers.length <= 3, s.blockers.length);
    check(`${c.name}: the prompt carries the compressed turns`, turns.length > 0 && turns.every(t => A.buildPrompt(s, turns).includes(t)));
  }
  console.log('');
  console.table(rows);
  check('no network calls', netCalls === 0, netCalls);
}

async function health() {
  const PAUSE = A.PAUSE_FILE;
  // 1 · error classes, from the analyser's own log
  const k = (m, b = 'cli') => A.classifyError(m, b);
  check('expired OAuth → auth', k('cli: Failed to authenticate: OAuth session expired and could not be refreshed').kind === 'auth');
  check('not logged in → auth', k('cli: Not logged in · Please run /login').kind === 'auth');
  check('auth fix names /login on the CLI path', has(k('cli: Not logged in · Please run /login').fix, '/login'));
  check('api 401 → auth, fix names the API key', k('api 401: {"type":"authentication_error"}', 'api').kind === 'auth' && has(k('api 401: x', 'api').fix, 'ANTHROPIC_API_KEY'));
  const lim = k("cli: You've hit your session limit · resets 5:30am (America/Los_Angeles)");
  check('session limit → limit, with the reset time', lim.kind === 'limit' && lim.reason === 'usage limit hit · resets 5:30am' && lim.fix === 'wait until 5:30am', lim);
  check('api 429 → limit', k('api 429: rate_limit_error', 'api').kind === 'limit');
  check('timeout → transient', k('spawnSync /usr/local/bin/claude ETIMEDOUT').kind === 'transient');
  check('bad JSON → transient', k('Unexpected token } in JSON at position 12').kind === 'transient');

  // 2 · a sign-in failure pauses the analyser and notifies once
  const c = buildChat('demo-health', 'add dark mode to the settings page', 'Dark mode toggle added to settings.');
  let calls = 0;
  const counting = fn => async (...a) => { calls++; return fn(...a); };
  const ok1 = await A.analyzeOnce(c.sid, c.tp, { model: counting(failing('cli: Failed to authenticate: OAuth session expired and could not be refreshed')), force: true });
  const m = JSON.parse(fs.readFileSync(PAUSE, 'utf8'));
  check('auth error: the run fails', ok1 === false);
  check('auth error: pause marker written', m.state === 'paused' && m.kind === 'auth' && m.reason === 'sign-in expired', m);
  const mins = (Date.parse(m.until) - Date.now()) / 60000;
  check('auth error: paused for about 10 minutes', mins > 9 && mins <= 10.1, mins.toFixed(2));
  await A.analyzeOnce(c.sid, c.tp, { model: counting(failing('cli: Not logged in · Please run /login')), force: true });
  await waitFor(() => notified().length > 0);
  await sleep(200);
  check('auth error: one notification, not one per failure', notified().filter(l => has(l, 'AI paused')).length === 1, notified());
  calls = 0;
  const ok3 = await A.analyzeOnce(c.sid, c.tp, { model: counting(answer({ goal: 'x' })) });
  check('while paused: the next reply is skipped without calling the model', ok3 === false && calls === 0, { ok3, calls });
  check('while paused: the log says why', has(fs.readFileSync(path.join(HOME, 'pulse.log'), 'utf8'), 'skip: AI paused (sign-in expired)'));

  // 3 · all three views say so, with the fix
  const sl = statusline(c);
  check('statusline: "AI paused" with the reason and the fix', has(sl, '⚠ AI paused · sign-in expired — run claude in a terminal, then /login'), sl);
  let p = dashboard();
  check('dashboard JSON: ai.state paused, reason and fix', p.ai.state === 'paused' && p.ai.reason === 'sign-in expired' && has(p.ai.fix, '/login'), p.ai);
  const html = fs.readFileSync(path.join(__dirname, 'dash.html'), 'utf8');
  check('dashboard page: renders an AI-paused banner', has(html, 'id="ai"') && has(html, '⚠ AI paused') && has(html, "ai.state === 'paused'"));
  const mb = menubar(p);
  check('menu bar: "AI paused" line and its fix', has(mb, '⚠ AI paused · sign-in expired') && has(mb, 'fix: run claude in a terminal, then /login'), mb);
  check('menu bar: the title carries the warning mark', has(mb.split('\n')[0], '⚠'), mb.split('\n')[0]);

  // 4 · a card older than the latest reply is marked stale
  const ago = n => new Date(Date.now() - n * 60000).toISOString().replace(/\.\d+Z$/, 'Z');
  editState(c, s => { s.analyzed_at = ago(20); s.stopped_at = ago(2); });
  const sl2 = statusline(c);
  check('statusline: stale card says how old it is', has(sl2, '◷ card 20m old'), sl2);
  p = dashboard();
  const sess = p.sessions.find(s => s.id === c.sid), proj = p.projects.find(x => x.name === 'demo-health');
  check('dashboard JSON: session and project marked stale', sess.stale === true && sess.stale_min === 20 && proj && proj.stale === true, { sess: [sess.stale, sess.stale_min], proj: proj && proj.stale });
  check('dashboard page: renders the stale tag', has(html, '◷ card ${p.stale_min}m old'));
  editState(c, s => { s.analyzed_at = ago(1); s.stopped_at = ago(2); });
  check('a card newer than the latest reply is not stale', !has(statusline(c), 'card') && dashboard().sessions.find(s => s.id === c.sid).stale === false);

  // 5 · the next success clears the pause
  const ok4 = await A.analyzeOnce(c.sid, c.tp, { model: answer({ goal: 'Dark mode in settings', mode: 'build', now: 'toggle wired', phases: [{ name: 'Toggle', pct: 100, weight: 1 }] }), force: true });
  check('recovery: a successful run removes the marker', ok4 === true && !fs.existsSync(PAUSE));
  check('recovery: statusline and dashboard drop the warning', !has(statusline(c), 'AI paused') && dashboard().ai.state === 'ok');
  check('recovery: the log says "AI resumed"', has(fs.readFileSync(path.join(HOME, 'pulse.log'), 'utf8'), 'AI resumed'));

  // 6 · a usage limit pauses with its reset time; a timeout does not pause
  await A.analyzeOnce(c.sid, c.tp, { model: failing("cli: You've hit your session limit · resets 5:30am (America/Los_Angeles)"), force: true });
  check('limit: paused with the reset time', has(statusline(c), 'usage limit hit · resets 5:30am — wait until 5:30am'), statusline(c));
  fs.unlinkSync(PAUSE);
  await A.analyzeOnce(c.sid, c.tp, { model: failing('spawnSync claude ETIMEDOUT'), force: true });
  check('timeout: no pause', !fs.existsSync(PAUSE));
  check('no network calls', netCalls === 0, netCalls);
}

async function needsYou() {
  const line2 = s => s.split('\n')[1] || '';
  // 1 · a permission prompt
  const c = chat('demo-perm');
  append(c, rec.user('deploy the preview build'), rec.tool('p1', 'Bash', { command: 'npm run deploy:preview' }));
  hook(c, 'UserPromptSubmit', { prompt: 'deploy the preview build' });
  fs.utimesSync(c.tp, new Date(Date.now() - 60000), new Date(Date.now() - 60000));   // the transcript stops while the prompt is open
  hook(c, 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  let s = readState(c);
  check('permission prompt → needs you', s.health.state === 'needs_you' && s.waiting_on_you && s.waiting_on_you.kind === 'permission', s.health);
  check('permission prompt: the detail says what it needs', s.health.detail === 'permission to use Bash', s.health.detail);
  let sl = statusline(c);
  check('statusline: badge and the permission text', has(sl, '⏸ needs you') && has(line2(sl), '⏸ permission to use Bash'), sl);
  let p = dashboard();
  check('dashboard JSON: needs you with the detail', p.sessions.find(x => x.id === c.sid).health_detail === 'permission to use Bash' && p.totals.needs_you >= 1);
  let mb = menubar(p);
  check('menu bar: "waiting on you — permission to use Bash"', has(mb, 'waiting on you — permission to use Bash'), mb);
  await waitFor(() => notified().some(l => has(l, 'needs you')));
  check('a notification goes out', notified().some(l => has(l, 'demo-perm') && has(l, 'needs you')), notified());
  // answered: the transcript moves on
  append(c, rec.result('p1', 'deployed'));
  const later = new Date((Date.parse(s.waiting_on_you.at) + 10000));
  fs.utimesSync(c.tp, later, later);
  check('permission answered: the statusline lets go', !has(statusline(c), 'needs you'), statusline(c));
  check('permission answered: the dashboard lets go', dashboard().sessions.find(x => x.id === c.sid).health === 'active');

  // 2 · other notifications are ignored
  const c2 = chat('demo-idle');
  append(c2, rec.user('rename the helper'), rec.say('Renamed it.'));
  hook(c2, 'UserPromptSubmit', { prompt: 'rename the helper' });
  hook(c2, 'Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
  check('idle_prompt is ignored', readState(c2).health.state === 'active');

  // 3 · a closing question in the reply
  const ask = (name, text) => { const x = chat(name); append(x, rec.user('add a login form')); hook(x, 'UserPromptSubmit', { prompt: 'add a login form' }); append(x, rec.say(text)); hook(x, 'Stop'); return readState(x); };
  s = ask('demo-q1', "I've added the login form with validation.\n\nShould I also add a password reset link?");
  check('closing question → needs you', s.health.state === 'needs_you' && s.health.detail === 'asked: Should I also add a password reset link?', s.health);
  check('closing question: waiting_on_you holds the text', s.waiting_on_you && s.waiting_on_you.kind === 'reply' && s.waiting_on_you.text === 'Should I also add a password reset link?', s.waiting_on_you);
  sl = statusline({ sid: 'eval-demo-q1' });
  check('statusline: shows the question', has(line2(sl), '⏸ asked: Should I also add a password reset link?'), sl);
  s = ask('demo-q2', 'Tests pass. Want me to commit?');
  check('question after a statement: only the question is kept', s.health.detail === 'asked: Want me to commit?', s.health.detail);
  s = ask('demo-q3', 'Two ways to store sessions. Which do you prefer?\n\n1. Postgres table\n2. Signed cookie');
  check('question followed by a list of options → needs you', s.health.state === 'needs_you' && s.health.detail === 'asked: Which do you prefer?', s.health);
  s = ask('demo-q4', '**Should I keep the old endpoint for a release?**');
  check('bold question → needs you', s.health.detail === 'asked: Should I keep the old endpoint for a release?', s.health.detail);
  s = ask('demo-n1', 'Done. The form validates email and password, and all 12 tests pass.');
  check('a plain summary is not a question', s.health.state === 'active' && !s.waiting_on_you, s.health);
  s = ask('demo-n2', 'Why did it fail? The config was missing a key. Fixed it, and the tests pass now.');
  check('a question answered in the same reply is not a question', s.health.state === 'active', s.health);
  // the user replies: the wait clears
  const q1 = { sid: 'eval-demo-q1', cwd: path.join(WORK, 'demo-q1'), tp: path.join(WORK, 'demo-q1', 'transcript.jsonl') };
  hook(q1, 'UserPromptSubmit', { prompt: 'yes, add it' });
  s = readState(q1);
  check('the next prompt clears the wait', s.health.state === 'active' && s.waiting_on_you === null, s);

  // 4 · AskUserQuestion: the dialog opens, then is answered
  const c4 = chat('demo-ask');
  append(c4, rec.user('add sign-in'));
  hook(c4, 'UserPromptSubmit', { prompt: 'add sign-in' });
  const q = { questions: [{ question: 'Which sign-in provider should I use?', header: 'Auth', options: [{ label: 'Email link' }, { label: 'GitHub' }], multiSelect: false }] };
  append(c4, rec.tool('a1', 'AskUserQuestion', q));
  const out = hook(c4, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: q });
  s = readState(c4);
  check('AskUserQuestion opens → needs you with the question', s.health.state === 'needs_you' && s.health.detail === 'asked: Which sign-in provider should I use?', s.health);
  check('PreToolUse prints nothing (never takes a permission decision)', out === '', out);
  hook(c4, 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use AskUserQuestion' });
  check('a permission notice during the dialog keeps the question', readState(c4).health.detail === 'asked: Which sign-in provider should I use?', readState(c4).health);
  check('statusline: shows the question', has(line2(statusline(c4)), '⏸ asked: Which sign-in provider should I use?'), statusline(c4));
  hook(c4, 'PostToolUse', { tool_name: 'AskUserQuestion', tool_input: q, tool_response: {} });
  s = readState(c4);
  check('AskUserQuestion answered → active, reading your reply', s.health.state === 'active' && s.now === 'reading your reply' && s.waiting_on_you === null, s);

  // 5 · blockers the analyser found reach the dashboard
  const c5 = buildChat('demo-blocked', 'wire the payments webhook', 'The handler is in; it cannot be tested until the signing secret exists.');
  await A.analyzeOnce(c5.sid, c5.tp, { force: true, model: answer({ goal: 'Payments webhook', mode: 'build', now: 'handler written', blockers: ['no sandbox signing secret', 'webhook URL not registered'], phases: [{ name: 'Handler', pct: 80, weight: 1 }] }) });
  p = dashboard();
  const proj = p.projects.find(x => x.name === 'demo-blocked');
  check('dashboard JSON: project blockers', proj && proj.blockers.join('|') === 'no sandbox signing secret|webhook URL not registered', proj && proj.blockers);
  check('dashboard JSON: session blockers', proj && proj.sessions[0].blockers.length === 2);
  const html = fs.readFileSync(path.join(__dirname, 'dash.html'), 'utf8');
  check('dashboard page: renders a blockers section', has(html, '<h5>blockers</h5><div class="blockers">'));
  check('no network calls', netCalls === 0, netCalls);
}

// A demo chat with edits only: no test run, no commit. `extra` adds tool steps before the closing line.
function editChat(name, prompt, closing, extra = []) {
  const c = chat(name);
  append(c,
    rec.user(prompt),
    rec.tool(`${name}-1`, 'Edit', { file_path: `${c.cwd}/src/app.js` }), rec.result(`${name}-1`, 'ok'),
    ...extra.flatMap(([id, tool, input, out]) => [rec.tool(`${name}-${id}`, tool, input), rec.result(`${name}-${id}`, out)]),
    rec.say(closing));
  hook(c, 'UserPromptSubmit', { prompt });
  hook(c, 'Stop');
  return c;
}
const line1 = sl => sl.split('\n')[0];
const card = (o = {}) => ({ goal: 'Cart page with running total', mode: 'build', now: 'editing the cart', done: false, scope_changed: false, blockers: [],
  phases: [{ name: 'Cart model', pct: 90, weight: 1 }, { name: 'Cart page', pct: 90, weight: 1 }], ...o });
const META = { cost: 0, backend: 'cli', ms: 1, tokens: { in: 0, out: 0 } };

async function number() {
  // 1 · an AI estimate climbs at most 25 points per update, and stops short of 100 with no evidence
  const c1 = editChat('demo-climb', 'add a cart page with a running total', 'The cart page is in.');
  const start = readState(c1).overall;
  const seen = [start];
  for (let i = 0; i < 5; i++) {
    await A.analyzeOnce(c1.sid, c1.tp, { force: true, model: answer(card({ phases: [{ name: 'Cart model', pct: 100, weight: 1 }, { name: 'Cart page', pct: 100, weight: 1 }] })) });
    seen.push(readState(c1).overall);
  }
  let s = readState(c1);
  check('AI estimate: source is llm', s.source === 'llm', s.source);
  check('AI estimate: the first update rises 25 points, not to 100', seen[1] === start + 25, seen);
  check('AI estimate: no single update rises more than 25 points', seen.every((v, i) => i === 0 || v - seen[i - 1] <= 25), seen);
  check('AI estimate: every phase at 100% but no test run or commit → stays at 95', s.overall === 95, seen);
  const jumps = s.history.map(h => h[1]).filter((v, i, a) => i > 0 && v - a[i - 1] > 25);
  check('AI estimate: history has no jump over 25 points', jumps.length === 0, s.history);

  // 2 · Claude says done, nothing backs it up → not 100, not "done", labelled
  const c2 = editChat('demo-said', 'fix the crash when a note has no title', 'Done! The crash is fixed.');
  await A.analyzeOnce(c2.sid, c2.tp, { force: true, model: answer(card({ goal: 'Fix crash on untitled notes', mode: 'fix', done: true,
    phases: [{ name: 'Fix', pct: 100, weight: 1 }] })) });
  s = readState(c2);
  check('says done, no evidence: below 100', s.overall < 100, s.overall);
  check('says done, no evidence: health is not "done"', s.health.state !== 'done', s.health);
  check('says done, no evidence: claimed_done is set', s.claimed_done === true, s.claimed_done);
  let sl = statusline(c2);
  check('statusline: "says done · not verified"', has(sl, 'says done · not verified'), sl);
  check('statusline: no "✓ done" badge', !has(sl, '✓ done'), sl);
  let p = dashboard();
  let proj = p.projects.find(x => x.name === 'demo-said');
  check('dashboard JSON: project and chat carry claimed_done', proj && proj.claimed_done === true && proj.sessions[0].claimed_done === true, proj && { p: proj.claimed_done, s: proj.sessions[0].claimed_done });
  let mb = menubar(p);
  check('menu bar: "says done, not verified"', has(mb, 'says done, not verified'), mb);
  hook(c2, 'UserPromptSubmit', { prompt: 'it still crashes on an empty note' });
  check('a new message clears "says done"', readState(c2).claimed_done === false);

  // 3 · done backed by a green test run → 100 and done at once
  const c3 = buildChat('demo-tested', 'fix the crash when a note has no title', 'Fixed. 12 tests pass.');
  await A.analyzeOnce(c3.sid, c3.tp, { force: true, model: answer(card({ goal: 'Fix crash on untitled notes', mode: 'fix', done: true, phases: [{ name: 'Fix', pct: 100, weight: 1 }] })) });
  s = readState(c3);
  check('says done + green tests: 100 and done', s.overall === 100 && s.health.state === 'done', { overall: s.overall, health: s.health });
  check('says done + green tests: the reason names the evidence', has(s.health.detail, 'tests pass'), s.health.detail);
  check('says done + green tests: no claimed_done', s.claimed_done === false);

  // 4 · done backed by a commit
  const c4 = editChat('demo-committed', 'rename the settings screen', 'Renamed and committed.',
    [[2, 'Bash', { command: 'git commit -am "rename settings"' }, '[main 1a2b3c] rename settings']]);
  await A.analyzeOnce(c4.sid, c4.tp, { force: true, model: answer(card({ goal: 'Rename the settings screen', done: true, phases: [{ name: 'Rename', pct: 100, weight: 1 }] })) });
  s = readState(c4);
  check('says done + a commit: 100 and done', s.overall === 100 && s.health.state === 'done' && has(s.health.detail, 'committed'), { overall: s.overall, health: s.health });

  // 5 · every todo done → 100 (the hook owns the number)
  const c5 = editChat('demo-todos', 'add dark mode', 'Dark mode is in.');
  const todos = [{ content: 'Add theme tokens', status: 'completed', activeForm: 'Adding theme tokens' }, { content: 'Wire the toggle', status: 'completed', activeForm: 'Wiring the toggle' }];
  hook(c5, 'PostToolUse', { tool_name: 'TodoWrite', tool_input: { todos }, tool_response: {} });
  await A.analyzeOnce(c5.sid, c5.tp, { force: true, model: answer(card({ goal: 'Dark mode', done: true })) });
  s = readState(c5);
  check('every todo done: 100, source todos', s.overall === 100 && s.source === 'todos', { overall: s.overall, source: s.source });
  check('statusline: names the source "todos"', /100% ▰+ todos/.test(line1(statusline(c5))), line1(statusline(c5)));

  // 6 · every % names its source
  sl = line1(statusline(c1));
  check('statusline: an AI estimate says "AI est"', /\d+% [▰▱]+ AI est/.test(sl), sl);
  editState(c1, x => { x.source = 'plan'; });
  check('statusline: a plan number says "plan"', /\d+% [▰▱]+ plan/.test(line1(statusline(c1))), line1(statusline(c1)));
  editState(c1, x => { x.source = 'llm'; });
  p = dashboard();
  check('dashboard JSON: every project and chat has a source', p.projects.every(x => ['plan', 'todos', 'llm', 'heuristic'].includes(x.source) && x.sessions.every(y => y.source)), p.projects.map(x => x.source));
  const html = fs.readFileSync(path.join(__dirname, 'dash.html'), 'utf8');
  check('dashboard page: labels plan / todos / AI estimate', has(html, "plan: 'plan', todos: 'todos', llm: 'AI estimate'") && has(html, 'srcLabel(p.source)') && has(html, 'srcLabel(s.source)'));
  mb = menubar(p);
  check('menu bar: chat lines name the source', /\d+% AI est/.test(mb) && /100% todos/.test(mb), mb);

  // 7 · plan-tracked numbers are unchanged: ticks win, no cap, the old done rule
  const plan = { countable: true, file: 'PLAN.md', name: 'PLAN.md', pct: 80, done: 8, total: 10, open: [], phases: [{ name: 'Build', pct: 80, total: 10, done: 8 }] };
  const fresh = { overall: 0, source: 'heuristic', phases: [], stats: { edits: 1 }, health: { state: 'active', detail: '' }, _plan: plan };
  const m = A.merge(fresh, card({ done: true, phases: [{ name: 'Build', pct: 100, weight: 1 }] }), META, 10);
  check('plan: the % is the plan\'s ticks (0 → 80 in one update)', m.overall === 80 && m.source === 'plan', { overall: m.overall, source: m.source });
  check('plan: done works as before, no "says done" label', m.health.state === 'done' && m.claimed_done === false, { health: m.health, claimed: m.claimed_done });
  check('no network calls', netCalls === 0, netCalls);
}

async function modes() {
  const talk = editChat('demo-chat', 'what is the difference between a mutex and a semaphore?', 'A mutex has one owner; a semaphore counts.');
  await A.analyzeOnce(talk.sid, talk.tp, { force: true, model: answer({ goal: 'Mutex versus semaphore', mode: 'conversation', now: 'explaining the difference', done: false, scope_changed: false, blockers: [], phases: [] }) });
  const look = editChat('demo-read', 'how does the image pipeline work here?', 'Images are resized, then uploaded.');
  await A.analyzeOnce(look.sid, look.tp, { force: true, model: answer({ goal: 'Understand the image pipeline', mode: 'explore', now: 'reading the resize step', done: false, scope_changed: false, blockers: [], phases: [{ name: 'Read code', pct: 40, weight: 1 }] }) });
  const work = editChat('demo-build', 'add a cart page', 'The cart page is half done.');
  await A.analyzeOnce(work.sid, work.tp, { force: true, model: answer(card({ phases: [{ name: 'Cart page', pct: 40, weight: 1 }] })) });

  const pctRe = /\d+%/;
  let sl = statusline(talk);
  check('statusline, conversation: says "chatting", no % anywhere', has(line1(sl), 'chatting') && !pctRe.test(sl), sl);
  sl = statusline(look);
  check('statusline, explore: says "exploring", no % on line 1', has(line1(sl), 'exploring') && !pctRe.test(line1(sl)), sl);
  check('statusline, build: still shows its %', pctRe.test(line1(statusline(work))), statusline(work));

  const p = dashboard();
  const html = fs.readFileSync(path.join(__dirname, 'dash.html'), 'utf8');
  check('dashboard JSON: modes reach the page', ['demo-chat:conversation', 'demo-read:explore', 'demo-build:build'].every(k => { const [n, md] = k.split(':'); const x = p.projects.find(y => y.name === n); return x && x.mode === md && x.sessions[0].mode === md; }));
  check('dashboard page: talk-only rows and chat lines show — and no source', has(html, "talkOnly(s) ? '—' : s.overall + '%'") && has(html, "noPct ? '—' : p.pct + '%'") && has(html, "talkOnly(s) ? '' : srcLabel(s.source)"));

  const mb = menubar(p).split('\n');
  const block = name => { const i = mb.findIndex(l => has(l, name) && !l.startsWith('--')); const out = [mb[i]]; for (let k = i + 1; k < mb.length && mb[k].startsWith('--'); k++) out.push(mb[k]); return i < 0 ? [] : out; };
  const chatBlock = block('demo-chat'), readBlock = block('demo-read'), buildBlock = block('demo-build');
  check('menu bar, conversation: no % on the project line or its chat lines', chatBlock.length > 1 && chatBlock.every(l => !pctRe.test(l.split('|')[0])), chatBlock);
  check('menu bar, explore: no % on the project line or its chat lines', readBlock.length > 1 && readBlock.filter(l => !has(l, 'Read code')).every(l => !pctRe.test(l.split('|')[0])), readBlock);
  check('menu bar, build: the chat line keeps its %', buildBlock.some(l => l.startsWith('--') && /\d+% AI est/.test(l)), buildBlock);
  const counted = p.projects.filter(x => x.health === 'active' && !['explore', 'conversation'].includes(x.mode)).map(x => x.pct);
  const avg = Math.round(counted.reduce((a, b) => a + b, 0) / counted.length), cells = Math.floor((avg + 10) / 20);
  check('menu bar title: the average leaves out talk-only chats', counted.length === 1 && has(mb[0], '▰'.repeat(cells) + '▱'.repeat(5 - cells)), { title: mb[0], counted });
  check('no network calls', netCalls === 0, netCalls);
}

async function goal() {
  const words = s => String(s).trim().split(/\s+/).length;
  // 1 · the prompt carries the latest request on its own line
  const st = { first_prompt: 'add a cart page with a running total', last_prompt: 'now make checkout work offline' };
  const pr = A.buildPrompt(st, ['user: now make checkout work offline']);
  check('prompt: LATEST REQUEST on its own line', pr.split('\n').includes('LATEST REQUEST: "now make checkout work offline"'), pr);
  check('prompt: no LATEST REQUEST when it is the first request', !has(A.buildPrompt({ first_prompt: 'x y', last_prompt: 'x y' }, ['user: x y']), 'LATEST REQUEST'));
  check('system prompt: tells the model to use LATEST REQUEST', has(A.SYSTEM, 'LATEST REQUEST') && has(A.SYSTEM, 'Check the LATEST REQUEST'));

  // 2 · a long goal is cut to 12 words
  const c = editChat('demo-goal', 'add a cart page with a running total', 'The cart page is in.');
  const long = 'Build a cart page that shows every item with its price and a running total that updates live when quantities change';
  await A.analyzeOnce(c.sid, c.tp, { force: true, model: answer(card({ goal: long })) });
  let s = readState(c);
  check('goal: at most 12 words', words(s.goal) <= 12, s.goal);
  check('goal: the cut keeps the opening words', s.goal.startsWith('Build a cart page that shows every item'), s.goal);
  const first = s.goal;

  // 3 · a different goal without a change of direction does not move it
  await A.analyzeOnce(c.sid, c.tp, { force: true, model: answer(card({ goal: 'Cart page' })) });
  s = readState(c);
  check('no scope change: goal kept, no history', s.goal === first && s.goal_history.length === 0, { goal: s.goal, h: s.goal_history });

  // 4 · the chat changes direction → new goal, old one kept
  append(c, rec.user('forget the cart for now, fix lost edits when syncing offline'), rec.tool('g-2', 'Read', { file_path: `${c.cwd}/src/sync.js` }), rec.result('g-2', 'queue'), rec.say('Looking at the sync queue.'));
  hook(c, 'UserPromptSubmit', { prompt: 'forget the cart for now, fix lost edits when syncing offline' });
  hook(c, 'Stop');
  check('prompt: the new request reaches the model', has(A.buildPrompt(readState(c), ['x']), 'LATEST REQUEST: "forget the cart for now, fix lost edits when syncing offline"'));
  await A.analyzeOnce(c.sid, c.tp, { force: true, model: answer(card({ goal: 'Fix lost edits when syncing offline', mode: 'fix', scope_changed: true, phases: [{ name: 'Find cause', pct: 20, weight: 1 }] })) });
  s = readState(c);
  check('scope change: goal replaced', s.goal === 'Fix lost edits when syncing offline', s.goal);
  check('scope change: old goal kept in goal_history', s.goal_history.length === 1 && s.goal_history[0].goal === first && !!s.goal_history[0].until, s.goal_history);
  check('scope change: flagged', s.scope_changed === true);
  let sl = line1(statusline(c));
  check('statusline: ↗ before the new goal', has(sl, '↗ Fix lost edits when syncing offline'), sl);
  const p = dashboard();
  const sess = p.projects.find(x => x.name === 'demo-goal').sessions[0];
  check('dashboard JSON: chat carries scope_changed and the old goal', sess.scope_changed === true && sess.goal_history[0].goal === first, sess);
  const html = fs.readFileSync(path.join(__dirname, 'dash.html'), 'utf8');
  check('dashboard page: ↗ with the old goal on hover', has(html, '${goalMark(s)}') && has(html, "' — was: '"));
  check('menu bar: ↗ before the goal', has(menubar(p), '↗ Fix lost edits when syncing offline'), menubar(p));

  // 5 · history is capped; a hand-set goal never moves
  for (let i = 0; i < 12; i++) await A.analyzeOnce(c.sid, c.tp, { force: true, model: answer(card({ goal: `Goal number ${i}`, scope_changed: true })) });
  check('goal_history: at most 10 entries', readState(c).goal_history.length === 10, readState(c).goal_history.length);
  editState(c, x => { x.goal = 'Hand-set goal'; x.goal_locked = true; x.scope_changed = false; x.goal_history = []; });   // what `pulse goal <text>` writes
  await A.analyzeOnce(c.sid, c.tp, { force: true, model: answer(card({ goal: 'Something else', scope_changed: true })) });
  s = readState(c);
  check('a hand-set goal never moves and leaves no history', s.goal === 'Hand-set goal' && s.goal_history.length === 0, { goal: s.goal, h: s.goal_history });
  check('a hand-set goal shows no ↗', s.scope_changed === false && !has(line1(statusline(c)), '↗'), line1(statusline(c)));
  check('no network calls', netCalls === 0, netCalls);
}

// ---------------------------------------------------------------- main
(async () => {
  const run = { baseline, health, 'needs-you': needsYou, number, modes, goal }[SUITE];
  if (!run) { console.error('usage: node lib/eval.js --baseline | --suite health|needs-you|number|modes|goal [--keep]'); process.exit(2); }
  try { await run(); }
  catch (e) { fail++; console.log(`FAIL  ${SUITE} threw: ${e.stack}`); }
  console.log(`\n${SUITE}: ${pass} passed, ${fail} failed${KEEP ? `  (kept ${HOME} and ${WORK})` : ''}`);
  if (!KEEP) { fs.rmSync(HOME, { recursive: true, force: true }); fs.rmSync(WORK, { recursive: true, force: true }); }
  process.exit(fail ? 1 : 0);
})();
