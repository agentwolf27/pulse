#!/usr/bin/env node
'use strict';
// Pulse — retrofit and catch-up for plan files.
//
//   draft.js draft <root>                      write PLAN.md from README, git log, docs and the goal
//                                              cards of past chats; ticks what the evidence shows is
//                                              done. Never overwrites: writes PLAN.draft.md if one exists.
//   draft.js reconcile <root> [--apply 1,3]    propose which open outcomes deserve a tick, with the
//                                              evidence; --apply ticks the ones you name. Pulse never
//                                              ticks on its own.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { projectFor, planFor } = require('./plan.js');
const A = require('./analyze.js');

const HOME = process.env.PULSE_HOME || path.join(os.homedir(), '.claude', 'pulse');
const STATE = path.join(HOME, 'state');
const TEMPLATE = [path.join(HOME, 'templates', 'PLAN.md'), path.join(__dirname, '..', 'templates', 'PLAN.md')].find(p => fs.existsSync(p));

const read = (p, n) => { try { const t = fs.readFileSync(p, 'utf8'); return n ? t.slice(0, n) : t; } catch { return ''; } };
const sh = (cmd, args, cwd) => { const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 20000 }); return r.status === 0 ? r.stdout : ''; };
const stripHtml = h => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<\/(h[1-6]|p|li|tr|div|section|article)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

// ---------------------------------------------------------------- material
function gather(root) {
  const m = { name: path.basename(root), readme: '', log: '', status: '', docs: [], plans: [], cards: [], todos: 0 };
  m.readme = read(path.join(root, 'README.md'), 7000);
  const git = fs.existsSync(path.join(root, '.git'));
  if (git) {
    m.log = sh('git', ['log', '--date=short', '--format=%ad %s', '-n', '80'], root).trim();
    m.status = sh('git', ['status', '--porcelain'], root).split('\n').filter(Boolean).slice(0, 25).join('\n');
    const grep = sh('git', ['grep', '-c', '-E', 'TODO|FIXME', '--', ':!*.min.*', ':!*lock*'], root);
    m.todos = grep.split('\n').filter(Boolean).reduce((n, l) => n + (parseInt(l.split(':').pop(), 10) || 0), 0);
  }
  for (const dir of ['docs', 'spec', 'planning', 'design-system']) {
    const d = path.join(root, dir);
    let files = []; try { files = fs.readdirSync(d); } catch { continue; }
    for (const f of files.filter(f => /\.(md|html)$/i.test(f)).slice(0, 6)) {
      const t = read(path.join(d, f)); if (!t) continue;
      m.docs.push({ file: `${dir}/${f}`, text: (f.endsWith('.html') ? stripHtml(t) : t).slice(0, 6000) });
    }
  }
  for (const f of ['ROADMAP.md', 'TASKS.md', 'PROGRESS.md', 'DECISIONS.md', 'HANDOFF.md', 'PLAN.md']) {
    const t = read(path.join(root, f), 5000); if (t) m.plans.push({ file: f, text: t });
  }
  if (process.env.PULSE_DRAFT_NO_CARDS) return m;   // a folder whose chats are about other things
  try {
    const cards = fs.readdirSync(STATE).filter(f => f.endsWith('.json')).map(f => { try { return JSON.parse(fs.readFileSync(path.join(STATE, f), 'utf8')); } catch { return null; } })
      .filter(s => s && s.cwd && s.goal && (s.cwd === root || s.cwd.startsWith(root + '/')))
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')).slice(0, 4);
    m.cards = cards.map(s => ({ when: (s.updated_at || '').slice(0, 10), goal: s.goal, phases: (s.phases || []).map(p => `${p.name} ${p.pct}%`).join(', '), now: s.now }));
  } catch {}
  return m;
}

function materialText(m) {
  const parts = [`PROJECT: ${m.name}`];
  if (m.readme) parts.push(`README.md:\n${m.readme}`);
  for (const p of m.plans) parts.push(`${p.file} (existing, may be stale):\n${p.text}`);
  for (const d of m.docs) parts.push(`${d.file}:\n${d.text}`);
  if (m.log) parts.push(`GIT LOG (newest first):\n${m.log}`);
  if (m.status) parts.push(`UNCOMMITTED CHANGES:\n${m.status}`);
  if (m.cards.length) parts.push(`WHAT RECENT CLAUDE CHATS WERE DOING:\n${m.cards.map(c => `- ${c.when}: ${c.goal} — ${c.phases}${c.now ? ` — last: ${c.now}` : ''}`).join('\n')}`);
  if (m.todos) parts.push(`TODO/FIXME markers in source: ${m.todos}`);
  let text = parts.join('\n\n');
  if (text.length > 60000) text = text.slice(0, 60000) + '\n[truncated]';
  return text;
}

// ---------------------------------------------------------------- draft
const DRAFT_SYSTEM = `You write a project's PLAN.md in a fixed house format, from the material you are given.
Plain words, no marketing. Return only a JSON object:
{
  "what": "one paragraph: what this project is, for someone who has never seen it",
  "why": "one or two sentences: the problem it solves, what was broken or missing",
  "outcomes": [ { "text": "a concrete, checkable outcome for the WHOLE project (not one chat)", "verify": "a shell command that proves it, or \\"\\" if none exists", "done": true|false, "evidence": "one short line: the commit, file, README line or test that shows it" } ],
  "out_of_scope": [ "things the project is deliberately not doing" ],
  "constraints": [ "stack, dependencies, things that must not change" ]
}
Rules: 6 to 12 outcomes, in the order the work happens, covering what is already built AND what is left. Outcomes are about the product; ignore housekeeping (tooling installs, "chore:" commits, graphify, formatting) — those are not outcomes. Mark done=true only with evidence from the material — a commit, a file that exists, a README status line, a passing test. If the material contradicts itself (an old plan says undecided, the git log shows it decided), trust the newer evidence and say so in the evidence field. If a phase breakdown exists in the material, follow it. Keep each outcome under 15 words.`;

async function draft(root, { write = true } = {}) {
  const proj = projectFor(root) || { root, name: path.basename(root), git: fs.existsSync(path.join(root, '.git')) };
  const m = gather(proj.root);
  if (!m.readme && !m.log && !m.docs.length && !m.plans.length) throw new Error('nothing to draft from: no README, git history, docs or plan files in ' + proj.root);
  process.stderr.write(`reading ${proj.name}: README ${m.readme ? 'yes' : 'no'} · ${m.log.split('\n').filter(Boolean).length} commits · ${m.docs.length} docs · ${m.plans.length} existing plan files · ${m.cards.length} chat goal cards\n`);
  const t0 = Date.now();
  const r = await A.callModel(materialText(m), { system: DRAFT_SYSTEM, model: 'sonnet', effort: 'medium', thinking: 6000, timeout: 240000, max_tokens: 3000 });
  const j = r.json || {};
  const outcomes = (Array.isArray(j.outcomes) ? j.outcomes : []).filter(o => o && typeof o.text === 'string' && o.text.trim()).slice(0, 12)
    .map(o => ({ text: A.clip(o.text, 110), verify: typeof o.verify === 'string' ? o.verify.trim().replace(/^`|`$/g, '') : '', done: o.done === true, evidence: A.clip(o.evidence || '', 120) }));
  if (outcomes.length < 3) throw new Error('the draft came back with fewer than 3 outcomes; nothing written');

  let tpl = fs.readFileSync(TEMPLATE, 'utf8');
  tpl = tpl.replace('<Project Name>', proj.name)
           .replace(/^One paragraph\..*$/m, A.clip(j.what || '', 600) || 'One paragraph. What this is, in plain language, for someone who has never seen it.')
           .replace(/^The problem it solves\..*$/m, A.clip(j.why || '', 300) || 'The problem it solves. What is broken or missing today.');
  const list = outcomes.map(o => `- [${o.done ? 'x' : ' '}] ${o.text}${o.verify ? ` — \`${o.verify}\`` : ''}`).join('\n');
  tpl = tpl.replace(/^- \[ \] <outcome>.*\n(?:- \[ \] <outcome>.*\n)*/m, list + '\n');
  const bullets = arr => (Array.isArray(arr) && arr.length ? arr.slice(0, 8).map(s => `- ${A.clip(String(s), 140)}`).join('\n') : null);
  const oos = bullets(j.out_of_scope), cons = bullets(j.constraints);
  if (oos) tpl = tpl.replace(/^What we are deliberately not doing.*$/m, oos);
  if (cons) tpl = tpl.replace(/^Stack, dependencies, things that must not change\.$/m, cons);
  const today = (d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)(new Date());   // local date, not UTC
  tpl += `\n---\n\n_Drafted by Pulse on ${today} from README, git log, docs and chat history. Evidence for ticked items:_\n`
       + outcomes.filter(o => o.done).map(o => `- ${o.text} — ${o.evidence || 'see git log'}`).join('\n') + '\n';

  const target = path.join(proj.root, 'PLAN.md');
  const dest = fs.existsSync(target) ? path.join(proj.root, 'PLAN.draft.md') : target;
  if (write) { const tmp = dest + '.tmp'; fs.writeFileSync(tmp, tpl); fs.renameSync(tmp, dest); }
  const done = outcomes.filter(o => o.done).length;
  return { dest, existed: dest !== target, outcomes: outcomes.length, done, pct: Math.round((done / outcomes.length) * 100), ms: Date.now() - t0, cost: r.cost, text: tpl };
}

// ---------------------------------------------------------------- reconcile
const RECON_SYSTEM = `You check a project's plan against what actually happened, and say which open outcomes now deserve a tick.
Return only a JSON object: { "proposals": [ { "n": <number from the list>, "tick": true|false, "evidence": "one line: the commit, test result, or transcript moment that verifies it — or why it is not verified" } ] }.
Rules: propose tick=true only when the evidence shows the outcome is done AND verified (a test passed, a command succeeded, a file demonstrably exists). "Claude said it was done" is not evidence. Include every listed outcome, ticked or not.`;

function openLines(file) {
  const out = []; let inFence = false, skipping = false;
  const { parsePlan } = require('./plan.js');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; return; }
    if (inFence) return;
    const h = /^(#{2,3})\s+(.*)$/.exec(raw);
    if (h) { skipping = /^(non-?goals?|out of scope|constraints?|why|what we are building)\b/i.test(h[2]); return; }
    const c = /^([ \t]*)[-*+][ \t]+\[( |~|\/)\][ \t]+(\S.*)$/.exec(raw);
    if (c && !skipping) out.push({ line: i, text: c[3].replace(/[*_`]/g, '').replace(/\s+[—–-]\s+`[^`]*`\s*$/, '').trim() });
  });
  return out;
}

async function reconcile(root, apply) {
  const proj = projectFor(root); if (!proj) throw new Error('not a project: ' + root);
  const plan = planFor(proj.root); if (!plan || plan.source !== 'plan') throw new Error('no checkbox plan to reconcile in ' + proj.root);
  const file = plan.file;
  const items = openLines(file);
  if (!items.length) return { file, items: [], proposals: [] };
  const since = plan.updated_at;
  const log = fs.existsSync(path.join(proj.root, '.git')) ? sh('git', ['log', `--since=${since}`, '--date=short', '--format=%ad %s'], proj.root).trim() : '';
  // the newest chat in this project, compressed the way the analyser does
  let turns = '';
  try {
    const states = fs.readdirSync(STATE).filter(f => f.endsWith('.json')).map(f => { try { return JSON.parse(fs.readFileSync(path.join(STATE, f), 'utf8')); } catch { return null; } })
      .filter(s => s && s.cwd && s.transcript_path && (s.cwd === proj.root || s.cwd.startsWith(proj.root + '/')) && fs.existsSync(s.transcript_path))
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    if (states[0]) { const { text } = A.readTail(states[0].transcript_path, 400 * 1024); turns = A.compress(text).turns.slice(-60).join('\n'); }
  } catch {}
  const user = [
    `PLAN FILE: ${path.basename(file)} (last edited ${since.slice(0, 16)})`,
    `OPEN OUTCOMES:\n${items.map((it, i) => `${i + 1}. ${it.text}`).join('\n')}`,
    log ? `COMMITS SINCE THE PLAN WAS LAST EDITED:\n${log}` : 'COMMITS SINCE THE PLAN WAS LAST EDITED: none',
    turns ? `RECENT CHAT (compressed, oldest first):\n${turns}` : '',
    'Return only the JSON object.',
  ].filter(Boolean).join('\n\n');
  const r = await A.callModel(user, { system: RECON_SYSTEM, effort: 'low', timeout: 180000, max_tokens: 1500 });
  const proposals = (Array.isArray(r.json.proposals) ? r.json.proposals : []).map(p => ({ n: Number(p.n), tick: p.tick === true, evidence: A.clip(p.evidence || '', 160) }))
    .filter(p => p.n >= 1 && p.n <= items.length).map(p => ({ ...p, text: items[p.n - 1].text, line: items[p.n - 1].line }));
  let applied = [];
  if (apply && apply.length) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const n of apply) {
      const it = items[n - 1]; if (!it) continue;
      lines[it.line] = lines[it.line].replace(/\[( |~|\/)\]/, '[x]'); applied.push(n);
    }
    const tmp = file + '.tmp'; fs.writeFileSync(tmp, lines.join('\n')); fs.renameSync(tmp, file);
  }
  return { file, items, proposals, applied, cost: r.cost };
}

// ---------------------------------------------------------------- CLI
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const cmd = args.shift();
    const applyIdx = args.indexOf('--apply');
    const apply = applyIdx >= 0 ? String(args[applyIdx + 1] || '').split(',').map(s => parseInt(s, 10)).filter(Boolean) : [];
    if (applyIdx >= 0) args.splice(applyIdx, 2);
    const dry = args.includes('--dry-run'); if (dry) args.splice(args.indexOf('--dry-run'), 1);
    const root = args[0] || process.cwd();
    if (cmd === 'draft') {
      const d = await draft(root, { write: !dry });
      process.stdout.write(d.text);
      process.stderr.write(`\n${dry ? 'dry run — nothing written' : 'wrote ' + d.dest}${d.existed ? ' (PLAN.md already exists — review the draft, then merge or replace by hand)' : ''}\n${d.outcomes} outcomes, ${d.done} already done (${d.pct}%) · ${(d.ms / 1000).toFixed(0)}s · $${(d.cost || 0).toFixed(3)}\n`);
    } else if (cmd === 'reconcile') {
      const r = await reconcile(root, apply);
      if (!r.items.length) { console.log('nothing open in ' + r.file); return; }
      console.log(`open outcomes in ${path.basename(r.file)}:`);
      for (const p of r.proposals) console.log(`  ${p.n}. ${p.tick ? '✓ tick' : '· keep'}  ${p.text}\n       ${p.evidence}`);
      const ticks = r.proposals.filter(p => p.tick).map(p => p.n);
      if (r.applied.length) console.log(`\nticked: ${r.applied.join(', ')}`);
      else if (ticks.length) console.log(`\nto apply: pulse-plan reconcile --apply ${ticks.join(',')}`);
      else console.log('\nnothing verified enough to tick');
    } else {
      console.error('usage: draft.js draft [root] [--dry-run] | reconcile [root] [--apply 1,3]'); process.exit(2);
    }
  })().catch(e => { console.error('pulse-plan: ' + e.message); process.exit(1); });
}

module.exports = { draft, reconcile, gather };
