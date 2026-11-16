/**
 * nam-base — NAM's integration with the `base` CLI.
 *
 * - Preflight: is base installed, is this folder a base workspace and project,
 *   and does the code map exist, parse and look fresh?
 * - Handoffs: numbered handover files are registered as base handoffs, one lane per agent.
 * - Forks: queued Task Assignment Prompts are registered as base forks until the
 *   Manager acks the completed task (or the item is cancelled).
 *
 * Warn-only by design: nothing here throws into a NAM command. Every function
 * returns a result object, and a failure becomes a warning that names its fix.
 * Set NAM_BASE=off to skip base entirely.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  listAgentQueues,
  loadManagerInbox,
  nowIso,
  projectRoot,
  readJson,
  readText,
  runtimePath,
  updateQueueItem,
  writeJson,
} from "./nam-lib.mjs";

const TIMEOUT_MS = Number(process.env.NAM_BASE_TIMEOUT_MS) || 20000;
const PREFLIGHT_TTL_MS = 60 * 60 * 1000;
const MAP_STALE_DAYS = 7;
const AUTOSYNC_AFTER_HOURS = 24;
const AUTOSYNC_COOLDOWN_MS = 60 * 60 * 1000;
const PROBE_NAME = "nam_preflight_probe_zz";
const HANDOVER_RE =
  /^\.nam\/Memory\/Handovers\/[^/]+\/([A-Za-z0-9_]+?)_Handover_File_(\d+)\.md$/;

export function baseDisabled() {
  return ["off", "0", "false", "no"].includes(
    String(process.env.NAM_BASE ?? "").trim().toLowerCase(),
  );
}

function root() {
  return path.resolve(projectRoot());
}

function normPath(p) {
  const s = path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
}

/** Path relative to the NAM project root, with forward slashes. */
export function toProjectRel(file) {
  return path.relative(root(), path.resolve(root(), file)).replace(/\\/g, "/");
}

function findUp(start, rel) {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, rel);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The code map that covers the NAM project root (nearest ancestor .base-ast), or null. */
export function codeMapPath() {
  return findUp(root(), path.join(".base-ast", "ast.ttl"));
}

function firstLine(text) {
  return (
    String(text || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) || ""
  );
}

function quote(p) {
  return `"${String(p).replace(/\\/g, "/")}"`;
}

/**
 * Run `base` in the NAM project root. Reads full output: piping base into a
 * reader that closes early makes it panic (exit 101).
 */
export function runBase(args, { timeoutMs = TIMEOUT_MS } = {}) {
  const res = spawnSync("base", args, {
    cwd: root(),
    env: { ...process.env },
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    const code = res.error.code;
    return {
      ok: false,
      missing: code === "ENOENT",
      stdout: "",
      error:
        code === "ENOENT"
          ? "base is not on PATH"
          : code === "ETIMEDOUT"
            ? `base ${args.slice(0, 2).join(" ")} timed out after ${timeoutMs} ms`
            : res.error.message,
    };
  }
  const ok = res.status === 0;
  return {
    ok,
    missing: false,
    stdout: res.stdout || "",
    error: ok
      ? null
      : firstLine(res.stderr) || firstLine(res.stdout) || `exit ${res.status}`,
  };
}

// ---------------------------------------------------------------- preflight

function resolveProject() {
  const forced = String(process.env.NAM_BASE_PROJECT || "").trim();
  if (forced) return { slug: forced, source: "NAM_BASE_PROJECT" };
  const r = runBase(["project", "list", "--json"]);
  if (!r.ok) return { slug: null, error: r.error };
  let rows;
  try {
    rows = JSON.parse(r.stdout);
  } catch {
    return { slug: null, error: "could not read `base project list --json`" };
  }
  const want = normPath(root());
  const hit = (Array.isArray(rows) ? rows : []).find(
    (p) => p?.path && normPath(p.path) === want,
  );
  return hit ? { slug: hit.id, name: hit.name, source: "path" } : { slug: null };
}

function gitIgnored(file) {
  const r = spawnSync("git", ["check-ignore", "-q", file], {
    cwd: root(),
    windowsHide: true,
    timeout: 5000,
  });
  if (r.error) return null;
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null; // not a git repo
}

function check(id, ok, detail, fix) {
  return ok || !fix ? { id, ok, detail } : { id, ok, detail, fix };
}

function runPreflight() {
  const rootDir = root();
  const checks = [];
  const info = {
    root: rootDir.replace(/\\/g, "/"),
    base_version: null,
    project: null,
    map: null,
    map_age_hours: null,
  };
  const syncFix = `base sync --ast --target ${quote(rootDir)}`;

  const ver = runBase(["--version"]);
  if (!ver.ok) {
    checks.push(
      check(
        "base_cli",
        false,
        ver.error,
        "Install base and put it on PATH: https://docs.basemode.ai/install",
      ),
    );
    return finish(info, checks);
  }
  info.base_version = (ver.stdout.match(/\d+\.\d+\.\d+/) || [ver.stdout.trim()])[0];
  checks.push(check("base_cli", true, `base ${info.base_version}`));

  const ws = findUp(rootDir, path.join(".base", "base.toml"));
  checks.push(
    ws
      ? check("workspace", true, path.dirname(path.dirname(ws)).replace(/\\/g, "/"))
      : check(
          "workspace",
          false,
          "no base workspace (.base/) at or above the project root",
          `base scaffold ${quote(rootDir)}`,
        ),
  );

  if (ws) {
    const proj = resolveProject();
    info.project = proj.slug;
    checks.push(
      proj.slug
        ? check(
            "project",
            true,
            proj.source === "path" ? `${proj.slug} (${proj.name})` : `${proj.slug} (from NAM_BASE_PROJECT)`,
          )
        : check(
            "project",
            false,
            proj.error || "no base project has the NAM project root as its path",
            `base project add --name ${quote(path.basename(rootDir))} --path ${quote(rootDir)}`,
          ),
    );
  }

  const map = findUp(rootDir, path.join(".base-ast", "ast.ttl"));
  if (!map) {
    checks.push(check("code_map", false, "no code map (.base-ast/ast.ttl)", syncFix));
    return finish(info, checks);
  }
  info.map = toProjectRel(map);
  info.map_age_hours =
    Math.round(((Date.now() - fs.statSync(map).mtimeMs) / 3600000) * 10) / 10;

  const probe = runBase(["ast", "query", "--contains", PROBE_NAME]);
  if (probe.ok) {
    checks.push(check("code_map", true, `${info.map} parses`));
  } else {
    const parse = /parse/i.test(probe.error || "");
    checks.push(
      check(
        "code_map",
        false,
        probe.error,
        parse
          ? `${syncFix} (if it breaks again, a CRLF file with a multi-line entity name is the likely cause: convert it to LF)`
          : syncFix,
      ),
    );
  }

  checks.push(
    info.map_age_hours > MAP_STALE_DAYS * 24
      ? check(
          "code_map_fresh",
          false,
          `map last updated ${Math.round(info.map_age_hours / 24)} days ago`,
          syncFix,
        )
      : check("code_map_fresh", true, `updated ${info.map_age_hours} h ago`),
  );

  const ignored = gitIgnored(map);
  if (ignored !== null) {
    checks.push(
      ignored
        ? check("code_map_ignored", true, "gitignored")
        : check(
            "code_map_ignored",
            false,
            `${info.map} is not gitignored`,
            "Add .base-ast/ to .gitignore",
          ),
    );
  }
  return finish(info, checks);
}

function finish(info, checks) {
  const failed = checks.filter((c) => !c.ok);
  return {
    ok: failed.length === 0,
    checked_at: nowIso(),
    ...info,
    checks,
    warnings: failed.map((c) =>
      c.fix ? `${c.id}: ${c.detail} → fix: ${c.fix}` : `${c.id}: ${c.detail}`,
    ),
  };
}

function cacheKey() {
  const rootDir = root();
  return JSON.stringify({
    root: normPath(rootDir),
    workspace: Boolean(findUp(rootDir, path.join(".base", "base.toml"))),
    map: findUp(rootDir, path.join(".base-ast", "ast.ttl")),
    project: process.env.NAM_BASE_PROJECT || null,
  });
}

/**
 * Preflight result. A passing result is cached for an hour in
 * .nam/Runtime/base_preflight.json (the map probe takes ~2 s on a large repo);
 * a failing one is re-checked every time so a fix shows up at once.
 * `force` always re-checks.
 */
export function preflight({ force = false } = {}) {
  if (baseDisabled()) {
    return { ok: false, disabled: true, warnings: ["NAM_BASE=off: base integration skipped"] };
  }
  const file = runtimePath("base_preflight.json");
  const key = cacheKey();
  if (!force) {
    const cached = readJson(file, null);
    const age = Date.now() - Date.parse(cached?.result?.checked_at || 0);
    if (cached?.result?.ok && cached.key === key && age >= 0 && age < PREFLIGHT_TTL_MS) {
      return { ...cached.result, cached: true };
    }
  }
  const result = runPreflight();
  try {
    writeJson(file, { key, result });
  } catch {
    // Runtime not writable: still return the result
  }
  return { ...result, cached: false };
}

/** Compact form for nam-cli JSON output. */
export function gateSummary(pf) {
  if (pf.disabled) return { disabled: true };
  const out = { ok: pf.ok, project: pf.project || null };
  if (!pf.ok) {
    out.warnings = pf.warnings;
    out.note = "NAM keeps working without base. Details: node .cursor/hooks/nam-cli.mjs doctor";
  }
  return out;
}

/**
 * Start a background `base sync --ast` when the map is over a day old.
 * Claude Code's base Stop hook refreshes the map every turn; Cursor has no
 * such hook, so this keeps Cursor sessions from querying a stale map.
 */
export function maybeAutosyncMap(pf) {
  if (baseDisabled() || !pf?.ok || pf.map_age_hours == null) return false;
  if (pf.map_age_hours < AUTOSYNC_AFTER_HOURS) return false;
  const marker = runtimePath("base_autosync.json");
  const last = readJson(marker, null);
  if (last && Date.now() - Date.parse(last.started_at) < AUTOSYNC_COOLDOWN_MS) return false;
  try {
    const child = spawn("base", ["sync", "--ast", "--target", root()], {
      cwd: root(),
      env: { ...process.env },
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
    writeJson(marker, { started_at: nowIso(), map_age_hours: pf.map_age_hours });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- slugs

export function kebab(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function taskNumber(taskRef) {
  const m = String(taskRef || "").match(/Task\s+(\d+(?:\.\d+)*)/i);
  return m ? m[1].replace(/\./g, "-") : null;
}

export function forkSlug(agent, item) {
  const n = taskNumber(item.task_ref);
  return ["nam", kebab(agent), item.id, n ? `task-${n}` : null].filter(Boolean).join("-");
}

export function handoffSlug(lane, number) {
  return `nam-${kebab(lane)}-handover-${number}`;
}

/** { prefix, number } for `.nam/Memory/Handovers/<dir>/<Prefix>_Handover_File_<N>.md`, else null. */
export function parseHandoverPath(rel) {
  const m = String(rel).match(HANDOVER_RE);
  return m ? { prefix: m[1], number: Number(m[2]) } : null;
}

function projectForWrites() {
  if (baseDisabled()) return { skipped: "NAM_BASE=off" };
  const pf = preflight();
  if (!pf.project) {
    const cause = (pf.checks || []).find((c) => !c.ok && c.id !== "code_map");
    return {
      skipped: `${cause ? cause.detail : "no base project for this folder"}; run \`node .cursor/hooks/nam-cli.mjs doctor\``,
    };
  }
  return { project: pf.project };
}

// ---------------------------------------------------------------- forks

export function registerFork(agent, item) {
  const p = projectForWrites();
  if (p.skipped) return { ok: false, skipped: p.skipped };
  const slug = forkSlug(agent, item);
  const doc = `.nam/Mailbox/${agent}/${item.tap_path}`;
  const r = runBase(["fork", "create", "--project", p.project, "--doc", doc, "--slug", slug]);
  if (!r.ok) return { ok: false, slug, error: r.error };
  updateQueueItem(agent, item.id, { base_fork: slug, base_fork_archived_at: null });
  return { ok: true, slug, doc };
}

export function archiveFork(agent, item) {
  if (!item?.base_fork || item.base_fork_archived_at) return { ok: true, noop: true };
  if (baseDisabled()) return { ok: false, skipped: "NAM_BASE=off" };
  const r = runBase(["fork", "archive", item.base_fork]);
  if (!r.ok && !/no fork/i.test(r.error || "")) {
    return { ok: false, slug: item.base_fork, error: r.error };
  }
  updateQueueItem(agent, item.id, { base_fork_archived_at: nowIso() });
  return { ok: true, slug: item.base_fork };
}

// ---------------------------------------------------------------- handoffs

function loadLinks() {
  const store = readJson(runtimePath("base_links.json"), {});
  if (!store.handoffs || typeof store.handoffs !== "object") store.handoffs = {};
  return store;
}

function saveLinks(store) {
  writeJson(runtimePath("base_links.json"), store);
}

export function registerHandoff(lane, docRel, number) {
  const p = projectForWrites();
  if (p.skipped) return { ok: false, skipped: p.skipped };
  const slug = handoffSlug(lane, number);
  const r = runBase([
    "handoff", "create",
    "--project", p.project,
    "--doc", docRel,
    "--lane", lane,
    "--slug", slug,
  ]);
  if (!r.ok) return { ok: false, slug, error: r.error };
  const links = loadLinks();
  links.handoffs[lane] = { slug, doc: docRel, registered_at: nowIso() };
  saveLinks(links);
  return { ok: true, slug, lane, doc: docRel };
}

export function archiveHandoff(lane) {
  const links = loadLinks();
  const h = links.handoffs[lane];
  if (!h) return { ok: true, noop: true };
  if (baseDisabled()) return { ok: false, skipped: "NAM_BASE=off" };
  const r = runBase(["handoff", "archive", h.slug]);
  if (!r.ok && !/no handoff/i.test(r.error || "")) {
    return { ok: false, slug: h.slug, error: r.error };
  }
  delete links.handoffs[lane];
  saveLinks(links);
  return { ok: true, slug: h.slug };
}

function pointerTargetsLane(lane) {
  const isManager = lane === "Manager";
  const text = readText(
    runtimePath(isManager ? "active_manager_handover.md" : "active_implementation_handover.md"),
  );
  if (!text || !text.trim()) return false;
  return isManager || text.toLowerCase().includes(lane.toLowerCase());
}

/** Archive a lane's handoff once its pointer file no longer targets it. */
export function archiveStaleHandoff(lane) {
  if (!loadLinks().handoffs[lane] || pointerTargetsLane(lane)) return { ok: true, noop: true };
  return archiveHandoff(lane);
}

// ---------------------------------------------------------------- reconcile

/**
 * Bring base forks and handoffs in line with NAM state:
 * - pending/claimed queue items without a fork → register
 * - forks of cancelled items, or of completed items the Manager acked → archive
 * - handoffs whose pointer file no longer targets their lane → archive
 * Dry run unless `apply`.
 */
export function reconcile({ apply = false } = {}) {
  const acked = new Set(
    loadManagerInbox()
      .entries.filter((e) => e.acked && e.agent && e.queue_id)
      .map((e) => `${e.agent}|${e.queue_id}`),
  );
  const actions = [];
  for (const { agent, items } of listAgentQueues()) {
    for (const item of items) {
      const live = item.status === "pending" || item.status === "claimed";
      const openFork = item.base_fork && !item.base_fork_archived_at;
      if (live && !item.base_fork) {
        actions.push({
          action: "register_fork", agent, id: item.id, task_ref: item.task_ref,
          slug: forkSlug(agent, item), run: () => registerFork(agent, item),
        });
      } else if (
        openFork &&
        (item.status === "cancelled" ||
          (item.status === "completed" && acked.has(`${agent}|${item.id}`)))
      ) {
        actions.push({
          action: "archive_fork", agent, id: item.id, task_ref: item.task_ref,
          slug: item.base_fork, run: () => archiveFork(agent, item),
        });
      }
    }
  }
  for (const [lane, h] of Object.entries(loadLinks().handoffs)) {
    if (!pointerTargetsLane(lane)) {
      actions.push({
        action: "archive_handoff", lane, slug: h.slug, run: () => archiveHandoff(lane),
      });
    }
  }
  if (apply && baseDisabled()) {
    return { apply, skipped: "NAM_BASE=off", actions: actions.map(({ run, ...a }) => a) };
  }
  return {
    apply,
    actions: actions.map(({ run, ...a }) => (apply ? { ...a, result: run() } : a)),
  };
}
