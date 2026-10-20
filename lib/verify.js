#!/usr/bin/env node
'use strict';
// Pulse — run the VERIFY commands a plan carries, and tick what passes.
//
//   verify.js <root> [--dry-run] [--apply] [--only 2,5]
//
// "VERIFY is a command, not a verdict." Every outcome in PLAN.md may end with a backticked
// command. This runs those commands, in the project root, and reports four outcomes per line:
// passed (exit 0), failed (non-zero), uncheckable (no command), refused (looks destructive).
// Nothing is ticked unless --apply is given, and then only lines whose command exited 0.
// This is the deterministic half of reconcile: it never asks a model whether work is done.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { projectFor, planFor } = require('./plan.js');

const REFUSE = /\b(rm\s+-rf|sudo|git\s+push|git\s+reset\s+--hard|git\s+clean|mkfs|dd\s+if=|:\(\)\s*\{|curl[^|]*\|\s*(ba)?sh|>\s*\/dev\/sd|chmod\s+-R\s+777|killall|shutdown|reboot)\b/i;
const TIMEOUT_MS = 120000;

function outcomes(file) {
  const out = []; let inFence = false, skipping = false;
  fs.readFileSync(file, 'utf8').split('\n').forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; return; }
    if (inFence) return;
    const h = /^(#{2,3})\s+(.*)$/.exec(raw);
    if (h) { skipping = /^(non-?goals?|out of scope|constraints?|why|what we are building)\b/i.test(h[2]); return; }
    const c = /^([ \t]*)[-*+][ \t]+\[([ xX~\/-])\][ \t]+(\S.*)$/.exec(raw);
    if (!c || skipping) return;
    const m = /`([^`]+)`\s*$/.exec(c[3]);
    out.push({ line: i, mark: c[2], text: c[3].replace(/\s+[—–-]\s+`[^`]*`\s*$/, '').replace(/[*_`]/g, '').trim(), cmd: m ? m[1].trim() : null });
  });
  return out;
}

function run(cmd, cwd) {
  const t0 = Date.now();
  const r = spawnSync('/bin/bash', ['-lc', cmd], { cwd, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PULSE_NESTED: '1', CI: '1' } });
  const tail = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-3).join(' ⏎ ').slice(0, 200);
  return { code: r.status, timedOut: !!r.error && r.error.code === 'ETIMEDOUT', ms: Date.now() - t0, tail };
}

function verify(root, { dryRun = false, apply = false, only = null } = {}) {
  const proj = projectFor(root); if (!proj) throw new Error('not a project: ' + root);
  const plan = planFor(proj.root); if (!plan || !plan.file || plan.source === 'tasks') throw new Error('no checkbox plan to verify in ' + proj.root);
  const items = outcomes(plan.file);
  const results = [];
  items.forEach((it, idx) => {
    const n = idx + 1;
    if (only && !only.includes(n)) return;
    const already = it.mark === 'x' || it.mark === 'X';
    if (!it.cmd) { results.push({ n, ...it, status: 'uncheckable', note: already ? 'ticked, no command' : 'no VERIFY command' }); return; }
    if (REFUSE.test(it.cmd)) { results.push({ n, ...it, status: 'refused', note: 'looks destructive; run it yourself if you mean it' }); return; }
    if (dryRun) { results.push({ n, ...it, status: 'would-run', note: '' }); return; }
    const r = run(it.cmd, proj.root);
    const status = r.timedOut ? 'failed' : r.code === 0 ? 'passed' : 'failed';
    results.push({ n, ...it, status, note: r.timedOut ? `timed out after ${TIMEOUT_MS / 1000}s` : `exit ${r.code} · ${(r.ms / 1000).toFixed(1)}s${r.tail ? ' · ' + r.tail : ''}` });
  });
  let ticked = [], unticked = [];
  if (apply && !dryRun) {
    const lines = fs.readFileSync(plan.file, 'utf8').split('\n');
    for (const r of results) {
      if (r.status === 'passed' && !(r.mark === 'x' || r.mark === 'X')) { lines[r.line] = lines[r.line].replace(/\[( |~|\/)\]/, '[x]'); ticked.push(r.n); }
      // A ticked outcome whose VERIFY now fails is the most important thing this finds. Say so; do not untick silently.
      if (r.status === 'failed' && (r.mark === 'x' || r.mark === 'X')) unticked.push(r.n);
    }
    if (ticked.length) { const tmp = plan.file + '.tmp'; fs.writeFileSync(tmp, lines.join('\n')); fs.renameSync(tmp, plan.file); }
  }
  return { file: plan.file, results, ticked, regressions: results.filter(r => r.status === 'failed' && (r.mark === 'x' || r.mark === 'X')).map(r => r.n) };
}

// ---------------------------------------------------------------- tick-guard
// Called by the PostToolUse hook the moment Claude edits a plan file. Compares the ticks
// with the last snapshot, runs the VERIFY of each newly ticked outcome, and hands Claude the
// failure as context: "you ticked X but its check exited 1". Nothing is unticked by Pulse;
// the model is told, in-turn, and it fixes the work or the tick. Silent when ticks are honest.
const TICK_TIMEOUT_MS = 30000;
function tickguard(file) {
  const os = require('os'), crypto = require('crypto');
  const HOME = process.env.PULSE_HOME || path.join(os.homedir(), '.claude', 'pulse');
  if (fs.existsSync(path.join(HOME, 'verify.off'))) return null;
  if (!fs.existsSync(file)) return null;
  const snapDir = path.join(HOME, 'ticks'); fs.mkdirSync(snapDir, { recursive: true });
  const snap = path.join(snapDir, crypto.createHash('sha1').update(file).digest('hex') + '.json');
  const items = outcomes(file);
  const ticked = items.filter(i => i.mark === 'x' || i.mark === 'X').map(i => i.text);
  let prev = null; try { prev = JSON.parse(fs.readFileSync(snap, 'utf8')); } catch {}
  const write = () => { try { fs.writeFileSync(snap, JSON.stringify({ ticked, at: new Date().toISOString() })); } catch {} };
  if (!prev) { write(); return null; }                                   // first sight: baseline, no verdicts
  const newly = items.filter(i => (i.mark === 'x' || i.mark === 'X') && !prev.ticked.includes(i.text));
  write();
  if (!newly.length) return null;
  const proj = projectFor(path.dirname(file));
  const root = proj ? proj.root : path.dirname(file);
  const failures = [], passes = [], unchecked = [];
  for (const it of newly.slice(0, 4)) {
    if (!it.cmd) { unchecked.push(it); continue; }
    if (REFUSE.test(it.cmd)) { unchecked.push(it); continue; }
    const r = spawnSync('/bin/bash', ['-lc', it.cmd], { cwd: root, encoding: 'utf8', timeout: TICK_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, PULSE_NESTED: '1', CI: '1' } });
    const timedOut = !!r.error && r.error.code === 'ETIMEDOUT';
    if (!timedOut && r.status === 0) passes.push(it);
    else failures.push({ it, code: timedOut ? 'timeout' : r.status, tail: ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-6).join('\n').slice(0, 600) });
  }
  return { newly, failures, passes, unchecked };
}

if (require.main === module && process.argv[2] === 'tickguard') {
  const res = tickguard(process.argv[3]);
  if (res && res.failures.length) {
    const msg = res.failures.map(f => `You ticked "${f.it.text}" in PLAN.md, but its VERIFY \`${f.it.cmd}\` ${f.code === 'timeout' ? 'timed out' : 'exited ' + f.code}${f.tail ? ':\n' + f.tail : ''}`).join('\n\n')
      + `\n\nPulse: an outcome is done when its VERIFY passes, not when it seems done. Either fix the work and run the command again, or untick it. Do not leave it ticked.`;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg } }));
  }
  process.exit(0);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = f => { const i = args.indexOf(f); if (i >= 0) { args.splice(i, 1); return true; } return false; };
  const dryRun = flag('--dry-run'), apply = flag('--apply');
  const oi = args.indexOf('--only'); let only = null; if (oi >= 0) { only = String(args[oi + 1] || '').split(',').map(s => parseInt(s, 10)).filter(Boolean); args.splice(oi, 2); }
  try {
    const v = verify(args[0] || process.cwd(), { dryRun, apply, only });
    const glyph = { passed: '✓', failed: '✗', uncheckable: '·', refused: '⊘', 'would-run': '›' };
    console.log(`${path.basename(v.file)} — ${v.results.length} outcome${v.results.length === 1 ? '' : 's'}${dryRun ? ' (dry run)' : ''}`);
    for (const r of v.results) console.log(`  ${glyph[r.status]} ${String(r.n).padStart(2)}. [${r.mark}] ${r.text.slice(0, 70)}${r.cmd ? `\n         ${r.status === 'would-run' ? 'would run' : r.status}: ${r.cmd}${r.note ? ' → ' + r.note : ''}` : `\n         ${r.note}`}`);
    const passed = v.results.filter(r => r.status === 'passed').length, failed = v.results.filter(r => r.status === 'failed').length, unc = v.results.filter(r => r.status === 'uncheckable').length;
    if (!dryRun) console.log(`\n${passed} passed · ${failed} failed · ${unc} uncheckable`);
    if (v.regressions.length) console.log(`⚠ ticked but failing now: ${v.regressions.join(', ')} — a regression, or a VERIFY that needs updating`);
    if (v.ticked.length) console.log(`ticked: ${v.ticked.join(', ')}`);
    else if (!dryRun && !apply) { const c = v.results.filter(r => r.status === 'passed' && r.mark === ' ').map(r => r.n); if (c.length) console.log(`to tick the ones that passed: pulse-plan verify --apply`); }
    process.exit(failed ? 1 : 0);
  } catch (e) { console.error('pulse-plan verify: ' + e.message); process.exit(2); }
}

module.exports = { verify, outcomes, tickguard };
