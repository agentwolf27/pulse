#!/usr/bin/env node
'use strict';
// Pulse — dashboard server. Zero dependencies.
// Reads ~/.claude/pulse/state/*.json, derives liveness / health / cost, and serves
// one page plus one JSON endpoint on 127.0.0.1 only.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { projectFor, planFor } = require('./plan.js');

const HOME  = process.env.PULSE_HOME || path.join(os.homedir(), '.claude', 'pulse');
const STATE = path.join(HOME, 'state');
const PORT  = Number(process.env.PULSE_PORT || 7788);
const PAGE  = path.join(__dirname, 'dash.html');

// $ per million tokens (Anthropic API list prices, mid-2026). Cache reads ≈10% of input,
// cache writes 125% — except Fable, whose cache reads are a flat $0.25.
// Only used when the statusline hasn't reported the real figure for a session.
const PRICES = [
  [/fable/,    { in: 10, out: 50, cr: 0.25, cw: 12.5 }],
  [/opus/,     { in: 5,  out: 25, cr: 0.5,  cw: 6.25 }],
  [/sonnet-5/, { in: 2,  out: 10, cr: 0.2,  cw: 2.5  }],
  [/sonnet/,   { in: 3,  out: 15, cr: 0.3,  cw: 3.75 }],
  [/haiku/,    { in: 1,  out: 5,  cr: 0.1,  cw: 1.25 }],
];
function priceFor(model) {
  const m = String(model || '').toLowerCase();
  for (const [re, p] of PRICES) if (re.test(m)) return p;
  return PRICES[1][1];
}
function estimateCost(tokens, model) {
  if (!tokens) return 0;
  const p = priceFor(model);
  return ((tokens.in || 0) * p.in + (tokens.out || 0) * p.out + (tokens.cr || 0) * p.cr + (tokens.cw || 0) * p.cw) / 1e6;
}

function readJSON(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function mtimeMs(file) { try { return fs.statSync(file).mtimeMs; } catch { return null; } }
function clip(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

const ORDER = { needs_you: 0, looping: 1, context: 2, active: 3, idle: 4, done: 5, ended: 6 };

function readSessions() {
  let files = [];
  try { files = fs.readdirSync(STATE).filter(f => f.endsWith('.json')); } catch { return []; }
  const now = Date.now();
  const out = [];
  for (const f of files) {
    const s = readJSON(path.join(STATE, f));
    if (!s || !s.session_id) continue;
    if (s.cwd && s.cwd.startsWith(HOME)) continue;            // our own headless worker (Phase 1)

    const live = readJSON(path.join(STATE, s.session_id + '.live')) || {};
    const tmt = s.transcript_path ? mtimeMs(s.transcript_path) : null;
    const lastActivity = tmt || Date.parse(s.updated_at || s.started_at || 0) || now;
    const idleS = Math.max(0, Math.round((now - lastActivity) / 1000));

    // sub-agent transcripts touched in the last two minutes
    let subagents = 0;
    if (s.transcript_path) {
      const dir = s.transcript_path.replace(/\.jsonl$/, '') + '/subagents';
      try {
        for (const g of fs.readdirSync(dir)) {
          const m = mtimeMs(path.join(dir, g));
          if (m && now - m < 120000) subagents++;
        }
      } catch {}
    }

    let health = (s.health && s.health.state) || 'active';
    if (s.ended) health = Number(s.overall) >= 100 ? 'done' : 'ended';
    else if ((health === 'active' || health === 'context') && idleS > 600) health = 'idle';
    const ctxPct = typeof live.ctx_pct === 'number' ? live.ctx_pct : (s.ctx_pct_est ?? null);
    if (health === 'active' && ctxPct != null && ctxPct >= 90) health = 'context';

    const estimated = typeof live.cost_usd !== 'number';
    const cost = estimated ? estimateCost(s.tokens, live.model || s.model) : live.cost_usd;

    const proj = projectFor(s.cwd);
    out.push({
      id: s.session_id,
      project: proj ? proj.name : (s.project || ''),   // the repo, not the worktree folder
      project_root: proj ? proj.root : null,
      cwd: s.cwd || '',
      title: s.title || s.goal || clip(s.first_prompt, 90) || s.project || '',
      goal: s.goal || null,
      mode: s.mode || 'build',
      overall: Number(s.overall || 0),
      source: s.source || 'heuristic',
      phases: s.phases || [],
      checklist: s.checklist || [],
      now: s.now || '',
      health,
      health_detail: (s.health && s.health.detail) || '',
      idle_s: idleS,
      last_activity: new Date(lastActivity).toISOString(),
      started_at: s.started_at || null,
      stopped_at: s.stopped_at || null,
      ended: !!s.ended,
      subagents: subagents || s.subagents || 0,
      cost, cost_estimated: estimated,
      model: live.model || s.model || null,
      ctx_pct: ctxPct,
      ctx_estimated: typeof live.ctx_pct !== 'number',
      compactions: s.compactions || 0,
      duration_ms: live.duration_ms ?? null,
      tokens: s.tokens || null,
      stats: s.stats || {},
      turns: s.turns || 0,
      replies: s.replies || 0,
      history: (s.history || []).slice(-40),
      first_prompt: clip(s.first_prompt, 400),
      scope_changed: !!s.scope_changed,
      plan_behind: !!s.plan_behind,
      plan_behind_detail: s.plan_behind_detail || '',
      blockers: s.blockers || [],
      analysis: s.analysis || null,
      analyzed_at: s.analyzed_at || null,
      transcript_path: s.transcript_path || null,
      _sort: [ORDER[health] ?? 9, -lastActivity],
    });
  }
  out.sort((a, b) => a._sort[0] - b._sort[0] || a._sort[1] - b._sort[1]);
  for (const s of out) delete s._sort;
  return out;
}

function summarize(sessions) {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const t = { live: 0, needs_you: 0, looping: 0, context: 0, idle: 0, done: 0, ended: 0, cost_today: 0, cost_estimated: false };
  for (const s of sessions) {
    if (!s.ended && s.idle_s < 600) t.live++;
    if (s.health in t) t[s.health]++;
    if (Date.parse(s.last_activity) >= dayStart.getTime()) {
      t.cost_today += s.cost || 0;
      if (s.cost_estimated && s.cost) t.cost_estimated = true;
    }
  }
  return t;
}

// ---------------------------------------------------------------- cost ledger
// Session cost is cumulative; the ledger books each increase to the local day it happened,
// so "cost by project by day" stays right for sessions that run across midnight.
const LEDGER = path.join(HOME, 'ledger.json');
let ledger = readJSON(LEDGER) || { sessions: {} };
let ledgerDirty = false, ledgerWrote = 0;
const localDay = d => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
function writeAtomic(file, obj) { const tmp = `${file}.tmp.${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, file); }

function updateLedger(sessions) {
  const today = localDay(Date.now());
  for (const s of sessions) {
    const cost = +(s.cost || 0).toFixed(4);
    const e = ledger.sessions[s.id] || (ledger.sessions[s.id] = { project: s.project, total: 0, est: !!s.cost_estimated, days: {} });
    e.project = s.project || e.project;              // keep names in step with worktree folding
    if (cost > e.total + 0.00005) {
      e.days[today] = +((e.days[today] || 0) + (cost - e.total)).toFixed(4);
      e.total = cost; e.est = !!s.cost_estimated; e.project = s.project || e.project;
      ledgerDirty = true;
    }
  }
  if (ledgerDirty && Date.now() - ledgerWrote > 10000) {
    try { writeAtomic(LEDGER, ledger); } catch {}
    ledgerDirty = false; ledgerWrote = Date.now();
  }
}

function costReport() {
  const days = {};
  for (const e of Object.values(ledger.sessions)) {
    for (const [day, v] of Object.entries(e.days || {})) {
      const d = days[day] || (days[day] = {});
      const p = d[e.project] || (d[e.project] = { cost: 0, est: false, sessions: 0 });
      p.cost = +(p.cost + v).toFixed(4); p.est = p.est || e.est; p.sessions++;
    }
  }
  const sorted = Object.keys(days).sort().reverse().slice(0, 14);
  return { today: localDay(Date.now()), days: Object.fromEntries(sorted.map(d => [d, days[d]])) };
}

// ---------------------------------------------------------------- projects
// A project is a repo, not a chat. Several sessions (and worktrees) fold into one row.
// Its percentage comes from the project's own plan file when that file is countable —
// which survives the end of any session — and otherwise from its liveliest session.
function groupProjects(sessions) {
  const byRoot = new Map();
  for (const s of sessions) {
    const p = projectFor(s.cwd);
    if (!p) continue;                      // scratchpads, temp dirs, the bare home folder
    if (!fs.existsSync(p.root)) continue;  // a folder that has been moved or deleted since
    const e = byRoot.get(p.root) || byRoot.set(p.root, {
      root: p.root, name: p.name, sessions: [], plan: planFor(p.root),
      live: 0, needs_you: 0, looping: 0, context: 0, subagents: 0, cost: 0, cost_estimated: false,
    }).get(p.root);
    e.sessions.push(s);
    if (!s.ended && s.idle_s < 600) e.live++;
    if (s.health === 'needs_you') e.needs_you++;
    if (s.health === 'looping') e.looping++;
    if (s.health === 'context') e.context++;
    e.subagents += s.subagents || 0;
    e.cost += s.cost || 0;
    e.cost_estimated = e.cost_estimated || (s.cost_estimated && !!s.cost);
  }

  const out = [];
  for (const e of byRoot.values()) {
    e.sessions.sort((a, b) => (ORDER[a.health] ?? 9) - (ORDER[b.health] ?? 9) || Date.parse(b.last_activity) - Date.parse(a.last_activity));
    const lead = e.sessions.find(s => !s.ended) || e.sessions[0];
    const planOk = e.plan && e.plan.countable;

    e.pct = planOk ? e.plan.pct : (lead ? lead.overall : 0);
    e.source = planOk ? 'plan' : (lead ? lead.source : 'heuristic');
    e.phases = planOk ? e.plan.phases.map(p => ({ name: p.name, pct: p.pct, done: p.done, total: p.total }))
                      : (lead ? lead.phases : []);
    e.goal = planOk ? null : (lead ? lead.goal : null);
    e.title = lead ? (lead.goal || lead.title) : e.name;
    e.now = lead ? lead.now : '';
    e.health = e.needs_you ? 'needs_you' : e.looping ? 'looping' : e.context ? 'context'
             : e.live ? 'active' : e.sessions.every(s => s.ended) ? 'ended' : 'idle';
    e.health_detail = (e.sessions.find(s => s.health === e.health) || {}).health_detail || '';
    e.last_activity = e.sessions.reduce((m, s) => Math.max(m, Date.parse(s.last_activity) || 0), 0);
    e.idle_s = Math.max(0, Math.round((Date.now() - e.last_activity) / 1000));
    e.cost = +e.cost.toFixed(4);
    e.mode = lead ? lead.mode : 'build';
    e.history = lead ? lead.history : [];
    e.open = planOk ? e.plan.open : [];
    e.plan_file = e.plan ? e.plan.file : null;
    e.plan_name = e.plan ? e.plan.name : null;
    e.plan_countable = !!planOk;
    e.plan_source = planOk ? e.plan.source : null;                 // 'plan' | 'tasks'
    e.plan_why = e.plan && !planOk ? e.plan.why : '';
    e.plan_counts = e.plan ? (e.plan.source === 'tasks'
      ? { done: e.plan.tasks.done, open: e.plan.tasks.open, unrecognised: e.plan.tasks.unrecognised }
      : { done: e.plan.done, half: e.plan.half, total: e.plan.total }) : null;
    e.plan_tasks = e.plan && e.plan.tasks && e.plan.source !== 'tasks' ? { done: e.plan.tasks.done, open: e.plan.tasks.open } : null;
    e.plan_behind = e.sessions.some(s => s.plan_behind);
    e.plan_behind_detail = (e.sessions.find(s => s.plan_behind) || {}).plan_behind_detail || '';
    e.session_count = e.sessions.length;
    e.sessions = e.sessions.map(s => ({
      id: s.id, title: s.title, goal: s.goal, overall: s.overall, source: s.source, health: s.health,
      health_detail: s.health_detail, now: s.now, idle_s: s.idle_s, ended: s.ended, cost: s.cost,
      cost_estimated: s.cost_estimated, model: s.model, ctx_pct: s.ctx_pct, ctx_estimated: s.ctx_estimated,
      subagents: s.subagents, mode: s.mode, phases: s.phases, checklist: s.checklist, history: s.history,
    }));
    delete e.plan;
    out.push(e);
  }
  out.sort((a, b) => (ORDER[a.health] ?? 9) - (ORDER[b.health] ?? 9) || b.last_activity - a.last_activity);
  for (const e of out) e.last_activity = new Date(e.last_activity).toISOString();
  return out;
}

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');
  if (url.pathname === '/api/sessions') {
    const sessions = readSessions();
    updateLedger(sessions);
    return send(res, 200, JSON.stringify({
      generated_at: new Date().toISOString(), totals: summarize(sessions),
      projects: groupProjects(sessions), sessions,
    }));
  }
  if (url.pathname === '/api/costs') return send(res, 200, JSON.stringify(costReport()));
  const m = url.pathname.match(/^\/api\/session\/([\w-]+)$/);
  if (m) {
    const s = readJSON(path.join(STATE, m[1] + '.json'));
    return s ? send(res, 200, JSON.stringify(s)) : send(res, 404, '{"error":"not found"}');
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try { return send(res, 200, fs.readFileSync(PAGE), 'text/html; charset=utf-8'); }
    catch { return send(res, 500, 'dash.html is missing next to dash.js', 'text/plain'); }
  }
  send(res, 404, 'not found', 'text/plain');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') process.exit(0);          // another pulse-dash already owns the port
  console.error('pulse-dash:', err.message);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`pulse-dash listening on http://127.0.0.1:${PORT}  state: ${STATE}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });
