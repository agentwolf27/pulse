#!/usr/bin/env node
'use strict';
// Pulse — the analyser (Phase 1). Runs in the background after each Claude reply.
//
// Reads the tail of the session transcript, compresses the recent turns, asks Haiku
// for a goal card (goal, phases, now-line, mode), merges the answer into the state
// file with a monotonic guard, and exits. Never blocks the terminal: the hook forks
// this and returns at once.
//
//   analyze.js <session_id> [transcript_path]     respect the debounce and lock
//   analyze.js --force <session_id> [path]        ignore the debounce
//   analyze.js --dry-run <session_id> [path]      print the prompt, call nothing
//   analyze.js --all                              force-analyse every session active in the last hour

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { projectFor, planFor } = require('./plan.js');

const HOME  = process.env.PULSE_HOME || path.join(os.homedir(), '.claude', 'pulse');
const STATE = path.join(HOME, 'state');
const LOG   = path.join(HOME, 'pulse.log');
const WORKER_DIR = path.join(HOME, 'worker');
const SYSTEM = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');

const MODEL_API = 'claude-haiku-4-5';
const MODEL_CLI = 'haiku';
const DEBOUNCE_MS  = Number(process.env.PULSE_DEBOUNCE_MS || 15000);   // min gap between analyses of one session
const MAX_PARALLEL = Number(process.env.PULSE_MAX_PARALLEL || 2);            // headless claude workers are heavy; never run more than this at once
const WINDOW_BYTES = 400 * 1024;   // read at most this much of the transcript tail
const MAX_CHARS    = 18000;        // ~4-5k tokens of compressed turns
const MAX_LINES    = 80;
const MODES = ['build', 'fix', 'explore', 'conversation'];
const PRICE = { in: 1, out: 5, cr: 0.1, cw: 1.25 };   // Haiku 4.5, $ per MTok

// ---------------------------------------------------------------- utils
const args = process.argv.slice(2);
const flag = f => { const i = args.indexOf(f); if (i >= 0) { args.splice(i, 1); return true; } return false; };
const FORCE = flag('--force'), DRY = flag('--dry-run'), ALL = flag('--all');

function log(sid, msg) {
  const line = `${new Date().toISOString().replace(/\.\d+Z$/, 'Z')} ${String(sid).slice(0, 8)} analyze ${msg}\n`;
  try { fs.appendFileSync(LOG, line); } catch {}
  if (DRY || process.stdout.isTTY) process.stderr.write(line);
}
const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
function writeAtomic(file, obj) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}
// macOS notification via bin/pulse-notify (cooldown + notify.off live there). Fire and forget.
function notify(sid, state, title, message) {
  const bin = path.join(HOME, 'bin', 'pulse-notify');
  if (!fs.existsSync(bin)) return;
  try { require('child_process').spawn(bin, ['--key', `${sid}:${state}`, title, message], { detached: true, stdio: 'ignore' }).unref(); } catch {}
}

// ---------------------------------------------------------------- transcript → compressed turns
function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);   // drop the partial first line
    return { text, size };
  } finally { fs.closeSync(fd); }
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(b => (b && b.type === 'text' ? b.text : '')).join(' ');
  return '';
}

function describeTool(b) {
  const inp = b.input || {};
  const base = p => String(p || '').split('/').slice(-2).join('/');
  switch (b.name) {
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': return `${b.name} ${base(inp.file_path || inp.notebook_path)}`;
    case 'Read': return `Read ${base(inp.file_path)}`;
    case 'Bash': return `Bash: ${clip(inp.description || String(inp.command || '').split('\n')[0], 90)}`;
    case 'Grep': case 'Glob': return `${b.name} ${clip(inp.pattern, 40)}`;
    case 'TodoWrite': {
      const t = Array.isArray(inp.todos) ? inp.todos : [];
      const done = t.filter(x => x.status === 'completed').length;
      const doing = t.find(x => x.status === 'in_progress');
      return `TodoWrite (${done}/${t.length} done${doing ? `, doing: ${clip(doing.activeForm || doing.content, 60)}` : ''})`;
    }
    case 'AskUserQuestion': {
      const q = Array.isArray(inp.questions) && inp.questions[0] ? inp.questions[0].question : '';
      return `AskUserQuestion: "${clip(q, 120)}"`;
    }
    case 'Agent': return `Agent: ${clip(inp.description || inp.prompt, 80)}`;
    case 'SendMessage': return `SendMessage to ${clip(inp.to, 30)}`;
    default:
      if (String(b.name).startsWith('mcp__')) { const [, srv, tool] = b.name.split('__'); return `${tool} (${srv})`; }
      return b.name;
  }
}

function summarizeResult(block) {
  let t = clip(blockText(block.content), 110);
  if (block.is_error || /\b(error|failed|exception|traceback)\b/i.test(t)) return `FAIL: ${t}`;
  return t.length ? t : 'ok';
}

function compress(text) {
  const lines = [];
  const byToolId = new Map();
  let title = null;
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    let r; try { r = JSON.parse(raw); } catch { continue; }
    if (r.type === 'custom-title' && r.customTitle) { title = r.customTitle; continue; }
    const m = r.message;
    if (!m) continue;
    if (r.type === 'user') {
      // system-generated user turns (task notifications, teammate messages) are context, not asks
      const userLine = t => {
        t = String(t);
        if (/^\s*<(task-notification|system-reminder|cross-session-message|ci-monitor-event)/.test(t) || /^Another Claude session sent a message/.test(t)) return `note: "${clip(t.replace(/<[^>]+>/g, ' '), 140)}"`;
        return `user: "${clip(t, 300)}"`;
      };
      if (typeof m.content === 'string') { if (m.content.trim()) lines.push(userLine(m.content)); continue; }
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b.type === 'text' && b.text && b.text.trim()) lines.push(userLine(b.text));
        else if (b.type === 'tool_result') {
          const i = byToolId.get(b.tool_use_id);
          const s = summarizeResult(b);
          if (i != null && lines[i] != null) lines[i] += ` → ${s}`;
        }
      }
    } else if (r.type === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'text' && b.text && b.text.trim()) lines.push(`claude: "${clip(b.text, 220)}"`);
        else if (b.type === 'tool_use') { lines.push(`claude: ${describeTool(b)}`); byToolId.set(b.id, lines.length - 1); }
      }
    }
  }
  let out = lines.slice(-MAX_LINES);
  let total = out.reduce((n, l) => n + l.length + 1, 0);
  while (out.length > 8 && total > MAX_CHARS) { total -= out[0].length + 1; out.shift(); }
  return { turns: out, title, assistantTurns: out.filter(l => l.startsWith('claude:')).length };
}

// ---------------------------------------------------------------- prompt
function buildPrompt(state, turns) {
  const phases = (state.phases || []).map(p => `${p.name} (${p.pct}%, weight ${p.weight})`).join(' · ');
  const card = state.goal
    ? `goal: ${state.goal}\nphases: ${phases || '(none)'}\nmode: ${state.mode || 'build'}`
    : '(empty — this is the first estimate for this chat)';
  const todos = (state.checklist || []).length
    ? state.checklist.map(t => `${t.done ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]'} ${clip(t.text, 100)}`).join('\n')
    : '(none)';
  const s = state.stats || {}, a = state.analyzed_stats || {};
  const d = k => Math.max(0, (s[k] || 0) - (a[k] || 0));
  const stats = `${d('edits')} edits · ${d('tests')} test runs (${d('tests_pass')} green) · ${d('commits')} commits · ${d('asks')} questions asked · ${d('errors')} error results`;
  // The project's own plan file is ground truth when it exists — the model should score
  // against it rather than inventing a parallel set of phases.
  const plan = state._plan;
  const planBlock = plan && plan.countable
    ? `PROJECT PLAN (${plan.name}) — this is the real checklist for the whole project, ${plan.done}/${plan.total} done.\n`
      + plan.phases.map(p => `  ${p.name}: ${p.done}/${p.total} done`).join('\n')
      + (plan.open.length ? `\n  open items: ${plan.open.slice(0, 6).map(o => o.text).join('; ')}` : '')
      + `\nUse these exact phase names and keep them in this order. Score each phase by what has ACTUALLY been done and verified in this chat, even if the file has not been ticked yet — that difference is how we notice a plan falling behind. This chat may only touch part of the plan.`
    : '';
  // Birth: this project has no plan yet and real work has started. Ask for the seed too — but
  // give the model the repo's own description, so a chat that merely happens to run inside an
  // unrelated folder does not become that folder's plan.
  const seedBlock = state._seed
    ? `SEED: this repository has no plan file yet and work has begun.`
      + (state._readme ? ` The repository's README begins: """${state._readme}"""` : ' The repository has no README.')
      + ` If the work in this chat is clearly about something OTHER than what the repository is (a different product, a side task), return "seed": null.`
      + ` Otherwise return "seed": { "what": one plain paragraph on what this project is (the repository, informed by the chat), `
      + `"why": one sentence on the problem it solves, "outcomes": 3 to 5 concrete, checkable outcomes for the WHOLE project (not just this chat), `
      + `each { "text": short outcome, "verify": a shell command that proves it, or "" if none exists, "done": true only if it is already verified } }.`
    : '';
  const h = state.health || {};
  const status = h.state && h.state !== 'active' ? `STATUS: ${h.state.replace('_', ' ')}${h.detail ? ' — ' + h.detail : ''}` : '';
  const compacted = state.compacted_at ? `NOTE: the early chat was compacted into a summary at ${state.compacted_at}; trust the GOAL CARD over the summary.` : '';
  return [
    `GOAL CARD:\n${card}`,
    planBlock,
    `TITLE: ${state.title || '(none)'}\nFIRST REQUEST: "${clip(state.first_prompt, 500) || '(unknown)'}"`,
    `TODOS:\n${todos}`,
    `RECENT TURNS (oldest first):\n${turns.join('\n')}`,
    `TOOL STATS since last estimate: ${stats}`,
    status, compacted, seedBlock,
    'Return only the JSON object.',
  ].filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------- model backends
function extractJSON(text) {
  const s = String(text || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON object in reply: ' + clip(s, 120));
  return JSON.parse(s.slice(a, b + 1));
}

async function callApi(user, opts = {}) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: opts.model === 'sonnet' ? 'claude-sonnet-5' : MODEL_API, max_tokens: opts.max_tokens || 800, system: opts.system || SYSTEM, messages: [{ role: 'user', content: user }] }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`api ${res.status}: ${clip(JSON.stringify(body), 200)}`);
  const text = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const u = body.usage || {};
  const cost = ((u.input_tokens || 0) * PRICE.in + (u.output_tokens || 0) * PRICE.out
              + (u.cache_read_input_tokens || 0) * PRICE.cr + (u.cache_creation_input_tokens || 0) * PRICE.cw) / 1e6;
  return { json: extractJSON(text), cost, backend: 'api', tokens: { in: u.input_tokens || 0, out: u.output_tokens || 0 } };
}

function findClaude() {
  if (process.env.PULSE_CLAUDE_BIN && fs.existsSync(process.env.PULSE_CLAUDE_BIN)) return process.env.PULSE_CLAUDE_BIN;
  const which = spawnSync('bash', ['-lc', 'command -v claude'], { encoding: 'utf8' });
  const w = (which.stdout || '').trim();
  if (w && fs.existsSync(w)) return w;
  const cands = [];
  try { for (const v of fs.readdirSync(path.join(os.homedir(), '.nvm/versions/node'))) cands.push(path.join(os.homedir(), '.nvm/versions/node', v, 'bin/claude')); } catch {}
  cands.push('/opt/homebrew/bin/claude', '/usr/local/bin/claude', path.join(os.homedir(), '.claude/local/claude'));
  return cands.reverse().find(c => fs.existsSync(c)) || null;
}

function callCli(user, opts = {}) {
  const bin = findClaude();
  if (!bin) throw new Error('claude binary not found (set PULSE_CLAUDE_BIN)');
  fs.mkdirSync(WORKER_DIR, { recursive: true });
  // No thinking by default: a 150-token JSON answer, and headless mode otherwise lets the
  // model reason for thousands of tokens (measured: 63 s / 5k output tokens per call).
  const env = { ...process.env, PULSE_NESTED: '1', MAX_THINKING_TOKENS: String(opts.thinking || 0) };
  delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
  // Not --bare: that skips keychain auth. These flags keep auth but strip the context
  // to ~250 tokens — no MCP servers, no skills, no user settings (so no hooks or plugins).
  const r = spawnSync(bin, [
    '-p', '--model', opts.model || MODEL_CLI, '--output-format', 'json', '--no-session-persistence',
    '--tools', '', '--max-turns', '1', '--effort', opts.effort || 'low', '--system-prompt', opts.system || SYSTEM,
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands', '--setting-sources', 'local',
  ], { input: user, cwd: WORKER_DIR, env, encoding: 'utf8', timeout: opts.timeout || 120000, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) throw r.error;
  let out; try { out = JSON.parse(r.stdout); } catch { throw new Error(`cli exit ${r.status}: ${clip(r.stderr || r.stdout, 200)}`); }
  if (out.is_error) throw new Error(`cli: ${clip(out.result, 200)}`);
  const u = out.usage || {};
  return { json: extractJSON(out.result), cost: Number(out.total_cost_usd) || 0, backend: 'cli',
           tokens: { in: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), out: u.output_tokens || 0 },
           api_ms: out.duration_api_ms || null };
}

async function callModel(user, opts = {}) {
  return process.env.ANTHROPIC_API_KEY ? callApi(user, opts) : callCli(user, opts);
}

// Global slots: at most MAX_PARALLEL workers across all sessions. Waits up to 90 s for one.
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function takeSlot() {
  const dir = path.join(HOME, 'slots');
  fs.mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    for (let i = 0; i < MAX_PARALLEL; i++) {
      const slot = path.join(dir, `slot-${i}`);
      try { const st = fs.statSync(slot); if (Date.now() - st.mtimeMs > 5 * 60 * 1000) fs.rmSync(slot, { recursive: true, force: true }); } catch {}
      try { fs.mkdirSync(slot); return () => { try { fs.rmSync(slot, { recursive: true, force: true }); } catch {} }; }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    await sleep(1500);
  }
  return null;
}

// ---------------------------------------------------------------- merge
function sanitizePhases(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(p => p && typeof p.name === 'string' && p.name.trim())
    .slice(0, 6)
    .map(p => ({ name: clip(p.name, 24), pct: Math.round(clamp(p.pct, 0, 100)), weight: Math.round(clamp(p.weight, 1, 5)) || 1 }));
}

function merge(fresh, j, meta, size) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const scopeChanged = j.scope_changed === true && !fresh.goal_locked;   // a hand-set goal never moves
  const incoming = sanitizePhases(j.phases);
  const old = Array.isArray(fresh.phases) ? fresh.phases : [];

  // phases: names are sticky, percentages only go up — unless the goal changed
  let phases;
  if (old.length && !scopeChanged) {
    const matched = old.map(o => { const n = incoming.find(p => norm(p.name) === norm(o.name)); return n ? { ...o, pct: Math.max(o.pct, n.pct) } : o; });
    const anyMatch = incoming.some(p => old.find(o => norm(o.name) === norm(p.name)));
    phases = (!anyMatch && incoming.length === old.length)
      ? old.map((o, i) => ({ ...o, pct: Math.max(o.pct, incoming[i].pct) }))
      : matched;
  } else {
    phases = incoming.length ? incoming : old;
  }

  const goal = fresh.goal_locked ? fresh.goal
    : (!fresh.goal || scopeChanged) && j.goal ? clip(j.goal, 80) : (fresh.goal || (j.goal ? clip(j.goal, 80) : null));
  const mode = MODES.includes(j.mode) ? j.mode : (fresh.mode || 'build');
  const hasTodos = (fresh.checklist || []).length > 0;
  const waiting = fresh.health && fresh.health.state === 'needs_you';

  let overall = Number(fresh.overall) || 0, source = fresh.source || 'heuristic';
  if (hasTodos) {
    source = 'todos';                                         // the hook owns the number
  } else if (phases.length) {
    const W = phases.reduce((n, p) => n + p.weight, 0) || 1;
    const v = Math.round(phases.reduce((n, p) => n + p.pct * p.weight, 0) / W);
    overall = scopeChanged ? v : Math.max(v, overall - 5);     // never drop more than 5 points unless the goal changed
    source = 'llm';
  }

  const quietSinceStop = !fresh.user_at || !fresh.stopped_at || Date.parse(fresh.user_at) <= Date.parse(fresh.stopped_at);
  let health = fresh.health || { state: 'active', detail: '' };
  if (j.done === true && !hasTodos && quietSinceStop && !waiting) { overall = 100; health = { state: 'done', detail: 'claude says the work is complete' }; }
  if (phases.length && phases.every(p => p.pct >= 100) && !hasTodos) overall = 100;

  // A countable plan file outranks everything: it is the project's own statement of the work,
  // it survives this chat, and it does not move when a session ends.
  const plan = fresh._plan;
  let planBehind = false, planBehindDetail = '', llmOverall = null;
  if (plan && plan.countable) {
    // What the model thinks has been done, scored against the plan's own phases, before the
    // file's ticks replace it. The gap between the two is the drift signal.
    if (incoming.length) {
      const W = incoming.reduce((n, p) => n + p.weight, 0) || 1;
      llmOverall = Math.round(incoming.reduce((n, p) => n + p.pct * p.weight, 0) / W);
      const ahead = incoming.filter(p => { const q = plan.phases.find(x => norm(x.name) === norm(p.name)); return q && q.total >= 2 && p.pct - q.pct >= 30; });
      if (llmOverall - plan.pct >= 25 || ahead.length) {
        planBehind = true;
        planBehindDetail = `chat estimates ~${llmOverall}% but ${plan.name} has ${plan.done}/${plan.total} ticked`
          + (ahead.length ? ` (${ahead.map(p => p.name).join(', ')} look further along than the file says)` : '');
      }
    }
    overall = plan.pct;
    source = 'plan';
    phases = plan.phases.map(p => ({ name: p.name, pct: p.pct, weight: Math.max(1, Math.min(5, p.total || 1)) }));
  }

  const out = { ...fresh, goal, mode, phases, overall, source, health };
  delete out._plan; delete out._seed; delete out._readme;
  out.plan_behind = planBehind; out.plan_behind_detail = planBehindDetail; out.llm_overall = llmOverall;
  out.plan = plan ? { file: plan.file, name: plan.name, pct: plan.pct, done: plan.done, total: plan.total, countable: plan.countable } : null;
  const lower1 = s => (s && /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);   // "Waiting for CI" → "waiting for CI"
  out.now = waiting ? fresh.now : (j.now ? lower1(clip(j.now, 80)) : fresh.now);
  out.blockers = Array.isArray(j.blockers) ? j.blockers.filter(b => typeof b === 'string').slice(0, 3).map(b => clip(b, 100)) : [];
  if (scopeChanged) { out.scope_changed = true; out.scope_changed_at = now; }
  else if (fresh.scope_changed && fresh.scope_changed_at && Date.now() - Date.parse(fresh.scope_changed_at) > 10 * 60 * 1000) out.scope_changed = false;

  out.analyzed_at = now;
  out.analyzed_cursor = size;
  out.analyzed_stats = { ...(fresh.stats || {}) };
  const a = fresh.analysis || { calls: 0, cost_usd: 0 };
  out.analysis = { calls: a.calls + 1, cost_usd: +(a.cost_usd + meta.cost).toFixed(5), backend: meta.backend, last_ms: meta.ms, last_api_ms: meta.api_ms || null, last_tokens: meta.tokens };
  out.updated_at = now;
  out.history = [...(fresh.history || []), [now, overall]].slice(-60);
  return out;
}

// ---------------------------------------------------------------- birth: seed PLAN.md
// The house template, filled in. Refuses to overwrite anything. Returns the outcome count.
function seedPlan(proj, state, seed) {
  const target = path.join(proj.root, 'PLAN.md');
  if (fs.existsSync(target)) return 0;
  const tplPath = [path.join(HOME, 'templates', 'PLAN.md'), path.join(__dirname, '..', 'templates', 'PLAN.md')].find(p => fs.existsSync(p));
  if (!tplPath) return 0;
  const s = seed && typeof seed === 'object' ? seed : {};
  const outcomes = (Array.isArray(s.outcomes) ? s.outcomes : [])
    .filter(o => o && typeof o.text === 'string' && o.text.trim()).slice(0, 6)
    .map(o => ({ text: clip(o.text, 110), verify: typeof o.verify === 'string' ? o.verify.trim().replace(/^`|`$/g, '') : '', done: o.done === true }));
  if (outcomes.length < 2) return 0;
  const what = clip(s.what || state.goal || state.first_prompt || '', 400) || 'One paragraph. What this is, in plain language, for someone who has never seen it.';
  const why = clip(s.why || '', 200) || 'The problem it solves. What is broken or missing today.';
  let tpl = fs.readFileSync(tplPath, 'utf8');
  tpl = tpl.replace('<Project Name>', proj.name)
           .replace(/^One paragraph\..*$/m, what)
           .replace(/^The problem it solves\..*$/m, why);
  const list = outcomes.map(o => `- [${o.done ? 'x' : ' '}] ${o.text}${o.verify ? ` — \`${o.verify}\`` : ''}`).join('\n');
  tpl = tpl.replace(/^- \[ \] <outcome>.*\n(?:- \[ \] <outcome>.*\n)*/m, list + '\n');
  if (!/<!--\s*pulse\s*-->/i.test(tpl)) tpl = tpl.replace(/^(# .*\n)/, `$1\n<!-- pulse -->\n`);
  const tmp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, tpl); fs.renameSync(tmp, target);
  return outcomes.length;
}

// ---------------------------------------------------------------- one session
async function analyzeOnce(sid, tpArg) {
  const file = path.join(STATE, `${sid}.json`);
  let state = readJSON(file);
  if (!state) { log(sid, 'skip: no state file'); return false; }
  const tp = tpArg || state.transcript_path;
  if (!tp || !fs.existsSync(tp)) { log(sid, 'skip: no transcript'); return false; }
  const force = FORCE || DRY;
  if (state.ended && !force) { log(sid, 'skip: session ended'); return false; }
  if (!force && state.analyzed_at && Date.now() - Date.parse(state.analyzed_at) < DEBOUNCE_MS) { log(sid, 'skip: debounce'); return false; }

  const { text, size } = readTail(tp, WINDOW_BYTES);
  if (!force && state.analyzed_cursor === size) { log(sid, 'skip: nothing new'); return false; }
  const { turns, title, assistantTurns } = compress(text);
  if (!assistantTurns) { log(sid, 'skip: no assistant turns yet'); return false; }
  if (title && !state.title) state.title = title;

  // The project's plan file, if it has one — ground truth for the prompt and for the number.
  const proj = projectFor(state.cwd);
  state._plan = proj ? planFor(proj.root) : null;
  // Birth rule: a git repo, no plan of any kind, and Claude has edited a file in this session.
  // Never on merely opening a folder, never twice, and never when switched off.
  state._seed = !!(proj && proj.git && !state._plan && (state.stats || {}).edits > 0 && !state.autoplan_at
                   && process.env.PULSE_AUTOPLAN !== 'off' && !fs.existsSync(path.join(HOME, 'autoplan.off'))
                   && !fs.existsSync(path.join(proj.root, 'PLAN.md')));
  if (state._seed) {
    try { state._readme = clip(fs.readFileSync(path.join(proj.root, 'README.md'), 'utf8').replace(/^#.*\n/, '').trim(), 700); } catch { state._readme = ''; }
  }

  const user = buildPrompt(state, turns);
  if (DRY) { process.stdout.write(`--- system ---\n${SYSTEM}\n--- user (${user.length} chars) ---\n${user}\n`); return true; }

  const release = await takeSlot();
  if (!release) { log(sid, 'skip: no free worker slot after 90 s'); return false; }
  const t0 = Date.now();
  let r;
  try { r = await callModel(user); }
  catch (e) { log(sid, `error: ${clip(e.message, 200)}`); return false; }
  finally { release(); }
  const ms = Date.now() - t0;

  const fresh = readJSON(file) || state;                     // the hook may have written meanwhile
  if (title && !fresh.title) fresh.title = title;
  fresh._plan = state._plan;
  const merged = merge(fresh, r.json, { cost: r.cost, backend: r.backend, ms, api_ms: r.api_ms, tokens: r.tokens }, size);

  // Birth: write PLAN.md from the template, filled with what the model just told us.
  if (state._seed && proj) {
    if (r.json.seed === null) log(sid, 'autoplan: declined — the chat is not about this repository');
    let seeded = 0;
    try { seeded = seedPlan(proj, merged, r.json.seed); } catch (e) { log(sid, `autoplan: could not write PLAN.md (${clip(e.message, 80)})`); }
    if (seeded) {
      merged.autoplan_at = merged.updated_at;
      const p2 = planFor(proj.root);
      if (p2 && p2.countable) { merged.plan = { file: p2.file, name: p2.name, pct: p2.pct, done: p2.done, total: p2.total, countable: true }; merged.overall = p2.pct; merged.source = 'plan'; merged.phases = p2.phases.map(p => ({ name: p.name, pct: p.pct, weight: Math.max(1, p.total || 1) })); }
      notify(sid, 'plan', `Pulse · ${proj.name} · plan created`, `PLAN.md seeded with ${seeded} outcomes from this chat — open it and adjust`);
      log(sid, `autoplan: wrote ${path.join(proj.root, 'PLAN.md')} (${seeded} outcomes)`);
    }
  }

  writeAtomic(file, merged);
  if ((fresh.health || {}).state !== 'done' && merged.health.state === 'done') notify(sid, 'done', `Pulse · ${merged.project || ''} · done`, merged.goal || merged.title || '');
  if (!fresh.plan_behind && merged.plan_behind) log(sid, `plan behind: ${merged.plan_behind_detail}`);
  log(sid, `ok ${r.backend} ${ms}ms $${r.cost.toFixed(4)} → ${merged.overall}% ${merged.mode} "${clip(merged.goal, 50)}" phases=${merged.phases.map(p => `${p.name}:${p.pct}`).join(',')} now="${clip(merged.now, 50)}"${r.json.scope_changed ? ' SCOPE_CHANGED' : ''}`);
  return true;
}

// ---------------------------------------------------------------- lock + main
function withLock(sid, fn) {
  const dir = path.join(STATE, `${sid}.lock`);
  const pending = path.join(STATE, `${sid}.pending`);
  const acquire = () => { try { fs.mkdirSync(dir); return true; } catch (e) { if (e.code !== 'EEXIST') throw e; return false; } };
  if (!acquire()) {
    let stale = false;
    try { stale = Date.now() - fs.statSync(dir).mtimeMs > 180000; } catch { stale = true; }
    if (stale) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
    if (!stale || !acquire()) { try { fs.writeFileSync(pending, ''); } catch {} log(sid, 'busy: queued'); return Promise.resolve(false); }
  }
  return (async () => {
    try {
      for (let i = 0; i < 3; i++) {
        await fn();
        if (!fs.existsSync(pending)) break;                  // a Stop arrived while we were busy — go once more
        try { fs.unlinkSync(pending); } catch {}
      }
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  })();
}

async function main() {
  fs.mkdirSync(STATE, { recursive: true });
  if (ALL) {
    const files = fs.readdirSync(STATE).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const s = readJSON(path.join(STATE, f));
      if (!s || s.ended || !s.transcript_path) continue;
      let mtime = 0; try { mtime = fs.statSync(s.transcript_path).mtimeMs; } catch { continue; }
      if (Date.now() - mtime > 3600 * 1000) continue;
      await withLock(s.session_id, () => analyzeOnce(s.session_id, s.transcript_path));
    }
    return;
  }
  const [sid, tp] = args;
  if (!sid) { console.error('usage: analyze.js [--force|--dry-run] <session_id> [transcript_path] | --all'); process.exit(2); }
  await withLock(sid, () => analyzeOnce(sid, tp));
}

if (require.main === module) {
  main().catch(e => { log(args[0] || '-', `fatal: ${e.message}`); process.exit(1); });
}

module.exports = { callModel, callCli, callApi, compress, readTail, extractJSON, notify, clip, SYSTEM };
