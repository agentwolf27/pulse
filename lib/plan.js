'use strict';
// Pulse — project resolution and plan reading.
//
//   projectFor(cwd)  which project is this session in? Walks up; folds git worktrees (both
//                    `.claude/worktrees/<n>` and sibling `repo-wt-x` checkouts) into the main repo.
//   planFor(root)    the project's progress from the files it already keeps:
//                      1. a checkbox plan — PLAN.md / ROADMAP.md … in the house format, or
//                         OpenSpec / Spec Kit / GSD task files if the project uses one of those;
//                      2. house TASKS.md tables (In progress / Queued / Done), read with the same
//                         rules as parseTasks below.
//                    A checkbox plan that looks like a real plan wins; otherwise conformant tables.
//
// The plan file is the anchor: it outlives any session, so the number stops moving when a chat ends.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Checkbox plan files we accept, best first. Exact names only — a glob would pick up
// SECURITY.md checklists and design-system QA lists, which are not plans.
const PLAN_NAMES = ['PLAN.md', 'ROADMAP.md', 'PLANNING.md', 'MILESTONES.md', 'TODO.md'];
const PLAN_SUBDIRS = ['', 'docs', '.claude'];

// Headings that are never a phase, however many checkboxes they hold.
const SKIP_HEADING = /^(non-?goals?|out of scope|not doing|notes?|format|conventions?|glossary|appendix|references?|reference material|prior art|links?|resources?|history|changelog|session log|log|decisions?|open questions?|questions?|risks?|assumptions?|constraints?|requirements?|faq|contributing|licen[cs]e|security|install|usage|getting started|stack|layout|privacy|deployment|status board|status|thesis|one[- ]sentence.*|vision|background|context|why|what we are building|what is built|what works today|built but.*|bugs?|known issues|honesty gaps|counts?|metrics|dependency spine.*|jira|someday|maybe|icebox|parking|archive|the invariant.*|options considered|plan frozen.*)\b/i
  // plan-together critique rounds ("### tester · round 2") are argument, not phases
  ;
const SKIP_ROUND = /·\s*round\s*\d+/i;
// Whole-heading skips: "## Done" is a finished-work list, but "## Done looks like" — the house
// template's outcome checklist — is the most important section in the file.
const SKIP_EXACT = /^(done|completed|shipped|finished)$/i;

// Paths that are never a project: temp dirs, scratchpads, and the home directory itself.
const NOT_A_PROJECT = [
  os.tmpdir(), safeReal(os.tmpdir()), '/private/tmp', '/tmp', '/var/folders', '/private/var/folders',
  path.join(os.homedir(), '.claude'), path.join(os.homedir(), 'Library'),
].filter(Boolean);

function safeReal(p) { try { return fs.realpathSync(p); } catch { return null; } }
function statMs(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

const cache = new Map();
const TTL = 5000;

// ---------------------------------------------------------------- project root
function gitRoot(dir) {
  // A worktree's .git is a file: "gitdir: /repo/.git/worktrees/<name>". Fold it back to the main repo.
  const g = path.join(dir, '.git');
  let st; try { st = fs.statSync(g); } catch { return null; }
  if (st.isDirectory()) return dir;
  if (st.isFile()) {
    const m = /gitdir:\s*(.+)/.exec(read(g) || '');
    if (m) {
      const wt = m[1].trim();
      const i = wt.indexOf('/.git/worktrees/');
      if (i > 0) return wt.slice(0, i);
      const j = wt.indexOf('/.git');
      if (j > 0) return wt.slice(0, j);
    }
    return dir;
  }
  return null;
}

function projectFor(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  const hit = cache.get('p:' + cwd);
  if (hit && Date.now() - hit.at < TTL) return hit.value;

  let out = null;
  try {
    let dir = fs.existsSync(cwd) ? fs.realpathSync(cwd) : cwd;
    if (NOT_A_PROJECT.some(p => dir.startsWith(p)) || dir === os.homedir() || dir === '/') {
      out = null;
    } else {
      const w = dir.indexOf('/.claude/worktrees/');
      if (w > 0) dir = dir.slice(0, w);
      const w2 = dir.indexOf('/.claude-worktrees/');
      if (w2 > 0) dir = dir.slice(0, w2);

      let planDir = null, gRoot = null, d = dir;
      for (let i = 0; i < 12 && d && d !== '/' && d !== os.homedir(); i++) {
        if (!planDir && hasAnyPlan(d)) planDir = d;
        if (!gRoot) { const g = gitRoot(d); if (g) gRoot = g; }
        d = path.dirname(d);
      }
      const root = (gRoot && hasAnyPlan(gRoot)) ? gRoot : (planDir || gRoot || dir);
      out = { root, name: path.basename(root), git: !!gRoot };
    }
  } catch { out = null; }

  cache.set('p:' + cwd, { value: out, at: Date.now() });
  return out;
}

// ---------------------------------------------------------------- finding the files
function findPlanFile(root) {
  for (const sub of PLAN_SUBDIRS) {
    for (const name of PLAN_NAMES) {
      const p = path.join(root, sub, name);
      if (isFile(p)) return p;
      if (sub) { const lower = path.join(root, sub, name.toLowerCase()); if (isFile(lower)) return lower; }
    }
  }
  return null;
}

// Framework task files: several per project, all checkbox-shaped, archived ones excluded.
function findLayoutFiles(root) {
  const out = [];
  const add = (dir, name) => { try { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f, name); if (f !== 'archive' && isFile(p)) out.push(p); } } catch {} };
  add(path.join(root, 'openspec', 'changes'), 'tasks.md');   // OpenSpec
  add(path.join(root, 'specs'), 'tasks.md');                  // Spec Kit
  const gsd = path.join(root, '.planning', 'ROADMAP.md');     // GSD
  if (isFile(gsd)) out.push(gsd);
  return out;
}

// House task tables: the project's own TASKS.md, and workspace-style projects/<name>/TASKS.md.
function findTaskFiles(root) {
  const out = [];
  const t = path.join(root, 'TASKS.md');
  if (isFile(t)) out.push({ file: t, project: null });
  const pj = path.join(root, 'projects');
  try {
    for (const f of fs.readdirSync(pj)) {
      if (f.startsWith('_') || f.startsWith('.')) continue;
      const p = path.join(pj, f, 'TASKS.md');
      if (isFile(p)) out.push({ file: p, project: f });
    }
  } catch {}
  return out;
}

function hasAnyPlan(root) { return !!findPlanFile(root) || findLayoutFiles(root).length > 0 || findTaskFiles(root).length > 0; }

// ---------------------------------------------------------------- checkbox plans
// [x]/[X] done · [~] or [/] in progress (half) · [-] skipped (not counted) · [ ] open
const CHECKBOX = /^([ \t]*)[-*+][ \t]+\[([ xX~\/-])\][ \t]+(\S.*)$/;

// A placeholder stands in for work nobody has scoped yet ("- [ ] **TBD**", "- [ ] _first step_").
const PLACEHOLDER = /^(tbd|todo|t\.b\.d\.?|\.\.\.|…|xxx|placeholder|none|n\/a|first step|the thing being worked on|what follows|not yet|<outcome>|_+)$/i;
function isPlaceholder(raw) {
  const italicWhole = /^_[^_]+_$/.test(raw.trim());
  const bare = raw.replace(/[*_`~]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
  const head = bare.split(/\s+[—–-]\s+/)[0].trim();
  return italicWhole || PLACEHOLDER.test(bare) || PLACEHOLDER.test(head) || /^<[^>]+>$/.test(bare);
}

function cleanHeading(h) {
  return h
    .replace(/^~~(.*)~~$/, '$1')
    .replace(/^[A-Z]?\d+[a-z]?[.)]\s*/, '')                        // "0. Status board", "V1. The isometric…"
    .replace(/^(now|next|later|soon|future)\s*[—–-]\s*/i, '')
    .replace(/^phase\s*\d+\s*[:—–-]\s*/i, '')
    .replace(/[*_`]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
}

function parsePlan(text) {
  const lines = text.split('\n');
  const phases = [];
  let cur = null, inFence = false, skipping = false, body = 0;
  const marker = /<!--\s*pulse\s*-->/i.test(text) || /^\s*pulse:\s*(track|count)/im.test(text);
  const pushPhase = () => { if (cur) phases.push(cur); };
  const newPhase = name => ({ name, done: 0, half: 0, total: 0, pct: 0, placeholders: 0, skipped: 0, items: [] });

  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (raw.trim()) body++;
    const h = /^(#{2,3})\s+(.*)$/.exec(raw);
    if (h) {
      pushPhase();
      const name = cleanHeading(h[2]);
      skipping = SKIP_HEADING.test(name) || SKIP_HEADING.test(h[2].trim()) || SKIP_EXACT.test(name) || SKIP_ROUND.test(h[2]) || /^\d{4}-\d{2}-\d{2}/.test(name);
      cur = skipping ? null : newPhase(name);
      continue;
    }
    const c = CHECKBOX.exec(raw);
    if (!c || skipping) continue;
    if (!cur) cur = newPhase('Plan');
    cur.items.push({ indent: c[1].replace(/\t/g, '    ').length, mark: c[2], raw: c[3] });
  }
  pushPhase();

  let done = 0, half = 0, total = 0, skipped = 0;
  const openItems = [];
  for (const p of phases) {
    if (!p.items.length) { delete p.items; continue; }
    // Nested checkboxes: the outer ones are category labels. Keep only the shallowest level.
    const min = Math.min(...p.items.map(i => i.indent));
    for (const it of p.items) {
      if (it.indent !== min) continue;
      if (it.mark === '-') { p.skipped++; skipped++; continue; }         // explicitly dropped
      if (isPlaceholder(it.raw)) { p.placeholders++; continue; }        // unscoped: not a task yet
      const label = it.raw.replace(/[*_`]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+[—–-]\s+`[^`]*`\s*$/, '').trim();
      p.total++; total++;
      if (it.mark === 'x' || it.mark === 'X') { p.done++; done++; }
      else if (it.mark === '~' || it.mark === '/') { p.half++; half++; if (openItems.length < 12) openItems.push({ phase: p.name, text: label, half: true }); }
      else if (openItems.length < 12) openItems.push({ phase: p.name, text: label });
    }
    delete p.items;
    p.pct = p.total ? Math.round(((p.done + 0.5 * p.half) / p.total) * 100) : 0;
  }
  const placeholders = phases.reduce((n, p) => n + p.placeholders, 0);
  const emptyPhases = phases.filter(p => p.total === 0).length;

  // Show every phase that holds work, plus the still-unscoped ones after it.
  const lastReal = phases.map(p => p.total > 0).lastIndexOf(true);
  let shown = phases.filter((p, i) => p.total > 0 || p.placeholders > 0 || (lastReal >= 0 && i > lastReal));
  if (shown.length > 8) shown = shown.slice(0, 8);

  // Is this a checklist for the project, or a long document with a few checkboxes in it?
  const density = body ? total / body : 0;
  let countable = true, why = '';
  if (marker) { /* explicit opt-in wins */ }
  else if (total === 0) { countable = false; why = 'no checkboxes to count'; }
  else if (total < 3) { countable = false; why = `only ${total} checkbox${total === 1 ? '' : 'es'}`; }
  else if (density < 0.08) { countable = false; why = `${total} checkboxes in ${body} lines — they read as prose, not a plan`; }

  return {
    phases: shown, done, half, total, skipped, open: openItems, marker,
    density: +density.toFixed(3), body, placeholders, empty_phases: emptyPhases,
    pct: total ? Math.round(((done + 0.5 * half) / total) * 100) : null,
    partial: phases.length > 1 && emptyPhases / phases.length >= 0.25,
    countable, why,
  };
}

// ---------------------------------------------------------------- house TASKS.md tables
// The house reading: only `## In progress`, `## Queued` and
// `## Done` open a section; a table row with ≥4 cells is a task; `...` rows are placeholders;
// rows with fewer cells are counted as unreadable, never silently dropped; task rows under any
// other heading are reported as unrecognised. Progress = rows in Done ÷ all rows.
const SECTION = { 'in progress': 'progress', 'queued': 'queued', 'done': 'done', 'blocked': 'blocked' };
function parseTasks(text) {
  const out = { done: 0, open: 0, unreadable: 0, unrecognised: 0, sections: {}, items: [] };
  let section = null, heading = null, inFence = false;
  let cols = { title: 1, owner: 2, verify: 3 };                  // the house order; a header row can remap it
  for (const raw of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = /^##\s+(.*)$/.exec(raw);
    if (h) { heading = h[1].trim(); section = SECTION[heading.toLowerCase()] || null; cols = { title: 1, owner: 2, verify: 3 }; continue; }
    if (!/^\s*\|/.test(raw)) continue;
    const cells = raw.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    if (cells.length < 2) continue;
    if (cells.every(c => /^:?-*:?$/.test(c))) continue;                                    // delimiter row
    const lower = cells.map(c => c.toLowerCase());
    if (lower.includes('task') && (lower.includes('verify') || lower.includes('owner') || lower[0] === '#')) {   // header row: learn the columns
      cols = { title: lower.indexOf('task'), owner: lower.indexOf('owner'), verify: lower.indexOf('verify') };
      continue;
    }
    const title = (cells[cols.title] || '').replace(/[*_`]/g, '').trim();
    if (!title || title === '...' || title === '…') continue;                            // placeholder / template row
    if (cells.length < 4) { out.unreadable++; continue; }
    const item = { ref: cells[0], title, owner: cells[cols.owner] || '', verify: cells[cols.verify] || '', section: heading, state: section || 'unrecognised' };
    out.items.push(item);
    if (section === 'done') out.done++;
    else { out.open++; if (!section) out.unrecognised++; }
    out.sections[heading] = (out.sections[heading] || 0) + 1;
  }
  const n = out.done + out.open;
  out.total = n;
  out.pct = n ? Math.round((out.done / n) * 100) : null;
  // Exact enough to show as a number: at least three real rows and nothing unreadable.
  out.countable = n >= 3 && out.unreadable === 0;
  out.why = n === 0 ? 'no task rows' : n < 3 ? `only ${n} task row${n === 1 ? '' : 's'}` : out.unreadable ? `${out.unreadable} unreadable row${out.unreadable === 1 ? '' : 's'}` : '';
  return out;
}

// Only the project's own TASKS.md moves its number. Workspace-style `projects/<name>/`
// directories are workspace contents, not the app's progress — they are listed
// as sub-projects with their own counts and never folded into the parent.
function tasksFor(root) {
  const files = findTaskFiles(root);
  if (!files.length) return null;
  const agg = { files: [], done: 0, open: 0, unreadable: 0, unrecognised: 0, total: 0, items: [], sub: [] };
  let newest = 0;
  for (const f of files) {
    const t = parseTasks(read(f.file) || '');
    newest = Math.max(newest, statMs(f.file));
    agg.files.push(f.file);
    if (f.project) { if (t.total) agg.sub.push({ name: f.project, done: t.done, open: t.open, pct: t.pct }); continue; }
    agg.done += t.done; agg.open += t.open; agg.unreadable += t.unreadable; agg.unrecognised += t.unrecognised; agg.total += t.total;
    for (const it of t.items) agg.items.push({ ...it, project: null });
  }
  agg.pct = agg.total ? Math.round((agg.done / agg.total) * 100) : null;
  agg.countable = agg.total >= 3 && agg.unreadable === 0;
  agg.why = agg.total === 0 ? (agg.sub.length ? `${agg.sub.length} sub-projects under projects/, nothing at the root` : 'no task rows') : agg.total < 3 ? `only ${agg.total} task rows` : agg.unreadable ? `${agg.unreadable} unreadable rows` : '';
  agg.updated_at = new Date(newest).toISOString();
  agg.open_items = agg.items.filter(i => i.state !== 'done').slice(0, 8).map(i => ({ text: i.title, phase: i.section, verify: i.verify }));
  return agg;
}

// ---------------------------------------------------------------- combine
function planFor(root) {
  if (!root) return null;
  const key = 'f:' + root;
  const planFile = findPlanFile(root);
  const layoutFiles = planFile ? [] : findLayoutFiles(root);
  const taskFiles = findTaskFiles(root);
  if (!planFile && !layoutFiles.length && !taskFiles.length) return null;

  const stamp = [planFile, ...layoutFiles, ...taskFiles.map(f => f.file)].map(f => f + ':' + statMs(f)).join('|');
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp) return hit.value;

  let plan = null;
  if (planFile) {
    const parsed = parsePlan(read(planFile) || '');
    plan = { file: planFile, name: path.basename(planFile), kind: 'plan', updated_at: new Date(statMs(planFile)).toISOString(), ...parsed };
  } else if (layoutFiles.length) {
    // Several checkbox task files (OpenSpec / Spec Kit / GSD). Each file is one phase.
    let done = 0, half = 0, total = 0; const phases = [], open = [];
    for (const f of layoutFiles) {
      const p = parsePlan('<!-- pulse -->\n' + (read(f) || ''));
      const name = path.basename(path.dirname(f)) === '.planning' ? 'Roadmap' : path.basename(path.dirname(f)).replace(/^\d+-/, '').replace(/[-_]/g, ' ');
      phases.push({ name, done: p.done, half: p.half, total: p.total, pct: p.pct || 0 });
      done += p.done; half += p.half; total += p.total;
      for (const o of p.open) if (open.length < 12) open.push({ ...o, phase: name });
    }
    const kind = layoutFiles[0].includes('/openspec/') ? 'openspec' : layoutFiles[0].includes('/.planning/') ? 'gsd' : 'speckit';
    plan = {
      file: layoutFiles[0], name: `${kind} · ${layoutFiles.length} task file${layoutFiles.length === 1 ? '' : 's'}`, kind,
      updated_at: new Date(Math.max(...layoutFiles.map(statMs))).toISOString(),
      phases: phases.slice(0, 8), done, half, total, open, marker: true, placeholders: 0, empty_phases: 0, partial: false,
      pct: total ? Math.round(((done + 0.5 * half) / total) * 100) : null,
      countable: total >= 3, why: total >= 3 ? '' : 'fewer than 3 tasks',
    };
  }

  const tasks = taskFiles.length ? tasksFor(root) : null;

  // Which number drives the project: a countable checkbox plan first, then conformant tables.
  let source = null, pct = null, phases = [], open = [], countable = false, why = '';
  if (plan && plan.countable) { source = 'plan'; pct = plan.pct; phases = plan.phases; open = plan.open; countable = true; }
  else if (tasks && tasks.countable) { source = 'tasks'; pct = tasks.pct; open = tasks.open_items; countable = true;
    phases = [{ name: 'Tasks', done: tasks.done, total: tasks.total, pct: tasks.pct }]; }
  else { why = plan ? plan.why : (tasks ? tasks.why : ''); if (plan) { phases = plan.phases; open = plan.open; } }

  const value = {
    // the primary plan (may be null when only tables exist)
    file: plan ? plan.file : (tasks ? tasks.files[0] : null),
    name: plan ? plan.name : 'TASKS.md',
    kind: plan ? plan.kind : 'tasks',
    updated_at: plan ? plan.updated_at : tasks.updated_at,
    done: plan ? plan.done : tasks.done, half: plan ? plan.half : 0, total: plan ? plan.total : tasks.total,
    placeholders: plan ? plan.placeholders : 0, empty_phases: plan ? plan.empty_phases : 0, partial: plan ? plan.partial : false,
    marker: plan ? plan.marker : false, density: plan ? plan.density : 0, body: plan ? plan.body : 0,
    // the resolved view
    source, pct, phases, open, countable, why,
    plan: plan ? { file: plan.file, name: plan.name, pct: plan.pct, done: plan.done, half: plan.half, total: plan.total, countable: plan.countable, why: plan.why, phases: plan.phases } : null,
    tasks: tasks ? { files: tasks.files, pct: tasks.pct, done: tasks.done, open: tasks.open, unreadable: tasks.unreadable, unrecognised: tasks.unrecognised, countable: tasks.countable, why: tasks.why, sub: tasks.sub } : null,
  };
  cache.set(key, { value, stamp });
  return value;
}

const planForCwd = cwd => { const p = projectFor(cwd); return p ? planFor(p.root) : null; };

// ---------------------------------------------------------------- context line
// Injected into every session by the SessionStart hook. Silent when a project has no plan.
function contextFor(cwd) {
  const proj = projectFor(cwd);
  if (!proj) return '';
  const plan = planFor(proj.root);
  if (!plan) return '';
  const rel = path.relative(proj.root, plan.file) || plan.name;
  const rule = ` Keep it current as you work — tick a checkbox only when that item is genuinely done and its VERIFY passes (not merely attempted), and add new checkboxes for work you discover. Do not restructure the file or tick things you have not verified.`;
  if (!plan.countable) {
    return `Progress for this project is tracked in ${rel}. Keep it current as you work: when you finish something it lists, mark it done; when you discover work, add it.`;
  }
  if (plan.source === 'tasks') {
    return `Progress for this project is tracked in ${rel}: ${plan.tasks.done} tasks done, ${plan.tasks.open} open (${plan.pct}%). A task moves to "## Done" only when its VERIFY command passes.`
         + (plan.open.length ? ` Open now: ${plan.open.slice(0, 3).map(o => o.text).join('; ')}.` : '');
  }
  const openNow = plan.open.slice(0, 3).map(o => o.text).join('; ');
  const phase = plan.phases.find(p => p.pct > 0 && p.pct < 100) || plan.phases.find(p => p.pct === 0);
  return `Progress for this project is tracked in ${rel}: ${plan.done} of ${plan.total} items done (${plan.pct}%)`
       + (phase && plan.phases.length > 1 ? `, currently in "${phase.name}"` : '')
       + `.${openNow ? ` Next up there: ${openNow}.` : ''}` + rule;
}

// ---------------------------------------------------------------- CLI
if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  const cwd = arg || process.cwd();
  if (cmd === 'context') { process.stdout.write(contextFor(cwd)); }
  else if (cmd === 'json') { const proj = projectFor(cwd); process.stdout.write(JSON.stringify({ project: proj, plan: proj ? planFor(proj.root) : null }, null, 2)); }
  else if (cmd === 'next') {
    // A ready-to-paste /goal for the next open outcome. /goal is a session-scoped prompt Stop
    // hook that only sees the transcript, so the condition demands the VERIFY be run and shown.
    const proj = projectFor(cwd); const plan = proj ? planFor(proj.root) : null;
    if (!plan || !plan.open.length) { console.log('nothing open' + (plan ? ' in ' + plan.name : '')); process.exit(0); }
    const raw = fs.readFileSync(plan.file, 'utf8').split('\n');
    const first = plan.open[0];
    const line = raw.find(l => /^\s*[-*+]\s+\[[ ~\/]\]/.test(l) && l.includes(first.text.slice(0, 30)));
    const m = line && /`([^`]+)`\s*$/.exec(line);
    const check = m ? `run \`${m[1]}\` and show its full output; it exits 0` : 'show the evidence that proves it (a command output, a test result), not a claim';
    console.log(`/goal ${first.text}: ${check}; then tick that line in ${plan.name} and no other; do not tick anything else; or stop after 20 turns.`);
  }
  else {
    const proj = projectFor(cwd);
    if (!proj) { console.log('not a project: ' + cwd); process.exit(1); }
    const plan = planFor(proj.root);
    console.log(`project: ${proj.name}  (${proj.root})${proj.git ? '' : '  · not a git repo'}`);
    if (!plan) { console.log('plan:    none — run "pulse-plan init" (blank) or "pulse-plan draft" (from README, git log and docs)'); process.exit(0); }
    const pct = plan.pct === null ? '—' : plan.pct + '%';
    const filled = Math.round((plan.pct || 0) / 10);
    console.log(`plan:    ${plan.name}  ${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)} ${pct}  ${plan.source === 'tasks' ? `${plan.tasks.done} done · ${plan.tasks.open} open` : `${plan.done}/${plan.total}`}${plan.countable ? '' : `   (not counted: ${plan.why})`}`);
    for (const p of plan.phases) console.log(`  ${p.pct >= 100 ? '✓' : p.pct > 0 ? '◐' : '○'} ${p.name.padEnd(30).slice(0, 30)} ${p.done}/${p.total}`);
    if (plan.tasks && plan.source !== 'tasks') console.log(`tasks:   ${plan.tasks.done} done · ${plan.tasks.open} open${plan.tasks.unrecognised ? ` · ${plan.tasks.unrecognised} under a non-standard heading` : ''}${plan.tasks.unreadable ? ` · ${plan.tasks.unreadable} unreadable` : ''}`);
    if (plan.open.length) { console.log('next up:'); for (const o of plan.open.slice(0, 5)) console.log(`  ${o.half ? '◐' : '○'} ${o.text}`); }
  }
}

module.exports = { projectFor, planFor, planForCwd, findPlanFile, findTaskFiles, parsePlan, parseTasks, contextFor, PLAN_NAMES };
