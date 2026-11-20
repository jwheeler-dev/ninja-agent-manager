#!/usr/bin/env node
/**
 * Read-only token audit of NAM work, from Claude Code transcripts in ~/.claude/projects.
 * Usage tracks token-reads (the context size summed over every call), since ~98% of input is cache reads.
 *
 *   node .nam/Scripts/token-audit.mjs --since 2026-11-05 [--until 2026-11-20] [--runs] <project root>...
 *   node .nam/Scripts/token-audit.mjs --self-test
 *
 * Prints, per project: tasks finished (queue.json), plan / Memory_Root / inbox sizes, token-reads per task,
 * then one line per role (subagents as "<parent role> > <agent type>"). --runs adds one TSV row per run.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import assert from "node:assert/strict";

const ROOT = path.join(os.homedir(), ".claude", "projects");
// USD per million tokens [input, cache write 5m, cache write 1h, cache read, output], Claude pricing page 2026-10-17.
// API-equivalent, only to weigh models against each other: plan seats are not billed this way.
const PRICE = { "claude-opus-5-5": [4, 5, 8, 0.2, 20], "claude-sonnet-5-5": [2, 2.5, 4, 0.1, 10] };

/** Claude Code's transcript folder name for a project path. */
const slugOf = (p) => path.resolve(p).replace(/[^A-Za-z0-9]/g, "-");
const median = (l) => (l.length ? [...l].sort((a, b) => a - b)[Math.floor(l.length / 2)] : 0);
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const size = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

/** One transcript: calls inside [since, until), deduplicated by message id. */
async function scan(file, since, until) {
  const seen = new Set();
  const models = {};
  const s = { calls: 0, ctx1: 0, sumCtx: 0, maxCtx: 0, out: 0, compactions: 0, cost: 0, unpriced: null, cmd: null, model: "?" };
  const inWindow = (t) => t && t >= since && t < until;
  const rl = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length > 40e6) continue;
    if (!s.cmd) s.cmd = line.match(/<command-name>\/?(nam-[a-z-]+)/)?.[1] || null;
    const usage = line.includes('"usage"');
    if (!usage && !line.includes("compact")) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.type === "system" && /compact/.test(r.subtype || "")) {
      if (inWindow(r.timestamp)) s.compactions++;
      continue;
    }
    const m = r.message;
    if (!usage || !m?.usage || !m.id || m.model === "<synthetic>" || seen.has(m.id) || !inWindow(r.timestamp)) continue;
    seen.add(m.id);
    const u = m.usage;
    const cw = u.cache_creation_input_tokens || 0;
    const cw1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
    const cr = u.cache_read_input_tokens || 0;
    const ctx = (u.input_tokens || 0) + cw + cr;
    if (!s.calls) s.ctx1 = ctx;
    s.calls++;
    s.sumCtx += ctx;
    s.maxCtx = Math.max(s.maxCtx, ctx);
    s.out += u.output_tokens || 0;
    models[m.model] = (models[m.model] || 0) + 1;
    const p = PRICE[m.model];
    if (p) s.cost += ((u.input_tokens || 0) * p[0] + (cw - cw1h) * p[1] + cw1h * p[2] + cr * p[3] + (u.output_tokens || 0) * p[4]) / 1e6;
    else s.unpriced = m.model;
  }
  s.model = Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0]?.replace(/^claude-/, "") || "?";
  return s;
}

async function auditProject(root, since, until) {
  const project = path.basename(path.resolve(root));
  const slug = slugOf(root).toLowerCase();
  const dirs = fs.existsSync(ROOT)
    ? fs.readdirSync(ROOT).filter((d) => d.toLowerCase() === slug || d.toLowerCase().startsWith(`${slug}--claude-worktrees-`))
    : [];
  const roles = readJson(path.join(root, ".nam/Runtime/roles.json"), {}).conversations || {};
  const runs = [];
  const recent = (f) => fs.statSync(f).mtime.toISOString() >= since; // a file untouched since `since` has no calls in the window
  for (const d of dirs) {
    const dir = path.join(ROOT, d);
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
      const id = f.slice(0, -6);
      const s = recent(path.join(dir, f)) ? await scan(path.join(dir, f), since, until) : { calls: 0 };
      const role = roles[id]?.role || { "nam-manager": "manager", "nam-impl": "implementation" }[s.cmd] || s.cmd || "other";
      if (s.calls) runs.push({ project, role, agent: "-", id, ...s });
      const sub = path.join(dir, id, "subagents");
      if (!fs.existsSync(sub)) continue;
      for (const a of fs.readdirSync(sub).filter((n) => n.endsWith(".jsonl"))) {
        if (!recent(path.join(sub, a))) continue;
        const agent = readJson(path.join(sub, a.replace(/\.jsonl$/, ".meta.json")), {}).agentType || "?";
        const ss = await scan(path.join(sub, a), since, until);
        if (ss.calls) runs.push({ project, role: `${role} > ${agent}`, agent, id: `${id}/${a.slice(0, -6)}`, ...ss });
      }
    }
  }
  const mailbox = path.join(root, ".nam/Mailbox");
  const done = [];
  for (const a of fs.existsSync(mailbox) ? fs.readdirSync(mailbox) : []) {
    const items = readJson(path.join(mailbox, a, "queue.json"), {}).items || [];
    done.push(...items.filter((i) => i.status === "completed" && i.completed_at >= since && i.completed_at < until));
  }
  // Fix rounds re-queue the same task, so count distinct task ids too.
  const tasks = new Set(done.map((i) => String(i.task_ref).match(/Task\s+[\d.]+/i)?.[0] || i.task_ref)).size;
  const items = done.length;
  const kb = (p) => `${(size(path.join(root, ".nam", p)) / 1024).toFixed(0)} KB`;
  return { project, runs, tasks, items, sizes: `plan ${kb("Implementation_Plan.md")}, Memory_Root ${kb("Memory/Memory_Root.md")}, inbox ${kb("Runtime/manager_inbox.json")}`, transcripts: dirs.length };
}

function report(results, since, until, showRuns) {
  const all = results.flatMap((r) => r.runs);
  const totalCost = all.reduce((t, r) => t + r.cost, 0) || 1;
  const k = (n) => (n / 1e3).toFixed(0);
  const M = (n) => (n / 1e6).toFixed(1);
  console.log(`NAM token audit ${since} to ${until}: ${all.length} runs, ${M(all.reduce((t, r) => t + r.sumCtx, 0))}M token-reads, est. API $${totalCost.toFixed(0)}`);
  const unpriced = [...new Set(all.map((r) => r.unpriced).filter(Boolean))];
  if (unpriced.length) console.log(`(no price in PRICE for ${unpriced.join(", ")}; est. $ leaves those calls out)`);
  for (const { project, runs, tasks, items, sizes, transcripts } of results) {
    const reads = runs.reduce((t, r) => t + r.sumCtx, 0);
    console.log(`\n== ${project}: ${tasks} tasks finished (${items} queue items); ${sizes}; ${M(reads)}M token-reads${tasks ? `, ${M(reads / tasks)}M per task` : ""}${transcripts ? "" : "; no transcript folder found"}`);
    console.log("role | runs | median calls | median ctx@1 k | avg ctx/call k | max ctx k | token-reads M | compactions | est $ | share $");
    const groups = new Map();
    for (const r of runs) groups.set(r.role, [...(groups.get(r.role) || []), r]);
    const rows = [...groups].map(([role, rs]) => {
      const sum = (f) => rs.reduce((t, r) => t + f(r), 0);
      return { role, rs, calls: sum((r) => r.calls), reads: sum((r) => r.sumCtx), comp: sum((r) => r.compactions), cost: sum((r) => r.cost) };
    });
    for (const g of rows.sort((a, b) => b.reads - a.reads)) {
      console.log([g.role, g.rs.length, median(g.rs.map((r) => r.calls)), k(median(g.rs.map((r) => r.ctx1))), k(g.reads / g.calls),
        k(Math.max(...g.rs.map((r) => r.maxCtx))), M(g.reads), g.comp, g.cost.toFixed(0), `${((100 * g.cost) / totalCost).toFixed(0)}%`].join(" | "));
    }
  }
  if (!showRuns) return;
  console.log("\nproject\trole\tmodel\tcalls\tctx@1 k\tavg ctx k\tmax ctx k\ttoken-reads M\tout k\tcompactions\test $\trun");
  for (const r of all.sort((a, b) => b.sumCtx - a.sumCtx)) {
    console.log([r.project, r.role, r.model, r.calls, k(r.ctx1), k(r.sumCtx / r.calls), k(r.maxCtx), M(r.sumCtx), k(r.out), r.compactions, r.cost.toFixed(2), r.id].join("\t"));
  }
}

async function selfTest() {
  assert.equal(slugOf("D:\\30 Ninjas\\genai-production-platform").toLowerCase(), "d--30-ninjas-genai-production-platform");
  const f = path.join(os.tmpdir(), `nam-token-audit-${process.pid}.jsonl`);
  const call = (id, ctx, t) => JSON.stringify({ type: "assistant", timestamp: t, message: { id, model: "claude-sonnet-5-5", usage: { input_tokens: 0, cache_read_input_tokens: ctx, output_tokens: 10 } } });
  fs.writeFileSync(f, [
    '{"type":"user","message":{"content":"<command-name>/nam-manager</command-name>"}}',
    call("a", 100, "2026-01-02"), call("a", 100, "2026-01-02"), call("b", 300, "2026-01-03"), call("c", 999, "2025-12-31"),
    JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: "2026-01-03" }),
  ].join("\n"));
  const s = await scan(f, "2026-01-01", "2026-02-01");
  fs.unlinkSync(f);
  assert.deepEqual([s.calls, s.ctx1, s.sumCtx, s.maxCtx, s.compactions, s.cmd, s.model], [2, 100, 400, 300, 1, "nam-manager", "sonnet-5-5"]);
  console.log("self-test ok");
}

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv.splice(i, 2)[1]; };
if (argv.includes("--self-test")) {
  await selfTest();
} else {
  const since = flag("--since");
  const until = flag("--until") || "9999";
  const showRuns = argv.includes("--runs");
  const roots = argv.filter((a) => a !== "--runs");
  if (!since || !roots.length) {
    console.error("Usage: node .nam/Scripts/token-audit.mjs --since <ISO date> [--until <ISO date>] [--runs] <project root>...");
    process.exit(1);
  }
  const results = [];
  for (const root of roots) results.push(await auditProject(root, since, until));
  report(results, since, until, showRuns);
}
