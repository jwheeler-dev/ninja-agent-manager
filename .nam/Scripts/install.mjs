#!/usr/bin/env node
/**
 * Install NAM (Ninja Agent Manager) from this source repo into a project.
 *
 * Copies product files only: guides, commands, hooks, and every host's prompt
 * wrappers (Cursor, Claude Code, VS Code Copilot, Continue, Gemini CLI).
 * Merges NAM's entries into .cursor/hooks.json and .claude/settings.json,
 * keeping the project's own hooks. Never touches project state (Mailbox
 * queues, Memory, Runtime, Implementation Plan).
 *
 * Every file it overwrites is first copied to
 * <dest>/.nam/tmp/backup-<YYYY-MM-DD>/<same relative path>.
 *
 * Usage:
 *   node .nam/Scripts/install.mjs --dest <project root> [--dry-run] [--allow-dirty]
 *
 * --allow-dirty  install even if product files here have uncommitted changes
 *                (refused by default so work in progress never ships by accident)
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** [directory, filename filter] pairs copied as-is. */
const COPY = [
  [".nam", (n) => n === "README.md"],
  [".nam/Guides", (n) => n.endsWith(".md")],
  [".nam/Mailbox", (n) => n === "README.md"],
  [".nam/Runtime", (n) => n === "README.md"],
  [".cursor/commands", (n) => /^nam-.*\.md$/.test(n)],
  [".cursor/hooks", (n) => /^nam-.*\.mjs$/.test(n)],
  [".cursor/skills/nam-migration", (n) => n === "SKILL.md"],
  [".claude/commands", (n) => /^nam-.*\.md$/.test(n)],
  [".claude/agents", (n) => /^nam-.*\.md$/.test(n)],
  [".github/prompts", (n) => /^nam-.*\.prompt\.md$/.test(n)],
  [".github/hooks", (n) => n === "nam.json"],
  [".continue/prompts", (n) => /^nam-.*\.md$/.test(n)],
  [".gemini/commands", (n) => /^nam-.*\.toml$/.test(n)],
];
const MERGE = [".cursor/hooks.json", ".claude/settings.json"];
const IS_NAM_HOOK = /\.cursor\/hooks\/nam-[\w-]+\.mjs/;

function parseArgs(argv) {
  const out = { dest: null, dryRun: false, allowDirty: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dest") out.dest = argv[++i];
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--allow-dirty") out.allowDirty = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

function productFiles() {
  const files = [];
  for (const [dir, keep] of COPY) {
    const abs = path.join(SRC, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (keep(name) && fs.statSync(path.join(abs, name)).isFile()) {
        files.push(`${dir}/${name}`);
      }
    }
  }
  return files;
}

function dirtyProductFiles() {
  const paths = [...new Set([...COPY.map(([d]) => d), ...MERGE])];
  const r = spawnSync("git", ["status", "--porcelain", "--", ...paths], {
    cwd: SRC,
    encoding: "utf8",
    env: { ...process.env },
    timeout: 15000,
  });
  if (r.error || r.status !== 0) return [];
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function sameContent(a, b) {
  const norm = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  return norm(a) === norm(b);
}

function readJsonFile(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Cursor hooks.json: { version, hooks: { event: [{ command, ... }] } } */
function mergeCursorHooks(dest, src) {
  const out = { ...src, ...dest, hooks: { ...(dest.hooks || {}) } };
  for (const [event, list] of Object.entries(out.hooks)) {
    out.hooks[event] = list.filter((h) => !IS_NAM_HOOK.test(h.command || ""));
    if (!out.hooks[event].length) delete out.hooks[event];
  }
  for (const [event, list] of Object.entries(src.hooks || {})) {
    out.hooks[event] = [...(out.hooks[event] || []), ...list];
  }
  return out;
}

/** Claude Code settings.json: { hooks: { event: [{ matcher?, hooks: [{ type, command }] }] } } */
function mergeClaudeSettings(dest, src) {
  const out = { ...dest, hooks: { ...(dest.hooks || {}) } };
  for (const [event, groups] of Object.entries(out.hooks)) {
    out.hooks[event] = groups
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !IS_NAM_HOOK.test(h.command || "")) }))
      .filter((g) => g.hooks.length);
    if (!out.hooks[event].length) delete out.hooks[event];
  }
  for (const [event, groups] of Object.entries(src.hooks || {})) {
    out.hooks[event] = [...(out.hooks[event] || []), ...groups];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.dest) {
    console.log("Usage: node .nam/Scripts/install.mjs --dest <project root> [--dry-run] [--allow-dirty]");
    process.exit(args.help ? 0 : 1);
  }
  const dest = path.resolve(args.dest);
  if (dest.toLowerCase() === SRC.toLowerCase()) throw new Error("--dest is this source repo");
  if (!fs.existsSync(dest)) throw new Error(`--dest does not exist: ${dest}`);

  const dirty = dirtyProductFiles();
  if (dirty.length && !args.allowDirty) {
    console.error("Uncommitted NAM product files in the source repo (commit them, or pass --allow-dirty):");
    for (const line of dirty) console.error(`  ${line}`);
    process.exit(1);
  }

  const backupRoot = path.join(dest, ".nam", "tmp", `backup-${today()}`);
  const report = { added: [], updated: [], unchanged: [], merged: [], stale: [] };
  const backup = (rel) => {
    const from = path.join(dest, rel);
    const to = path.join(backupRoot, rel);
    if (args.dryRun || fs.existsSync(to)) return; // keep the first backup of the day
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  };
  const write = (rel, contents, fromFile) => {
    const to = path.join(dest, rel);
    if (args.dryRun) return;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fromFile) fs.copyFileSync(fromFile, to);
    else fs.writeFileSync(to, contents, "utf8");
  };

  const files = productFiles();
  for (const rel of files) {
    const from = path.join(SRC, rel);
    const to = path.join(dest, rel);
    if (!fs.existsSync(to)) {
      write(rel, null, from);
      report.added.push(rel);
    } else if (sameContent(from, to)) {
      report.unchanged.push(rel);
    } else {
      backup(rel);
      write(rel, null, from);
      report.updated.push(rel);
    }
  }

  for (const rel of MERGE) {
    const srcCfg = readJsonFile(path.join(SRC, rel), null);
    if (!srcCfg) continue;
    const destFile = path.join(dest, rel);
    const destCfg = readJsonFile(destFile, {});
    const merged =
      rel === ".claude/settings.json"
        ? mergeClaudeSettings(destCfg, srcCfg)
        : mergeCursorHooks(destCfg, srcCfg);
    const text = JSON.stringify(merged, null, 2) + "\n";
    const current = fs.existsSync(destFile) ? fs.readFileSync(destFile, "utf8").replace(/\r\n/g, "\n") : null;
    if (current === text) {
      report.unchanged.push(rel);
      continue;
    }
    if (current !== null) backup(rel);
    write(rel, text);
    report.merged.push(rel);
  }

  // Record the installed version and source commit in the project's metadata (keeps its installedAt).
  const srcMeta = readJsonFile(path.join(SRC, ".nam", "metadata.json"), null);
  if (srcMeta) {
    const rel = ".nam/metadata.json";
    const metaFile = path.join(dest, rel);
    const destMeta = readJsonFile(metaFile, null);
    const rev = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: SRC, encoding: "utf8", env: { ...process.env }, timeout: 15000,
    });
    const commit = `${(rev.stdout || "unknown").trim()}${dirty.length ? "-dirty" : ""}`;
    if (destMeta?.version === srcMeta.version && destMeta?.installedFrom?.commit === commit) {
      report.unchanged.push(rel);
    } else {
      const now = new Date().toISOString();
      const next = {
        ...srcMeta,
        installedAt: destMeta?.installedAt || now,
        lastUpdated: now,
        installedFrom: { source: "ninja-agent-manager", commit },
      };
      if (destMeta) backup(rel);
      write(rel, JSON.stringify(next, null, 2) + "\n");
      (destMeta ? report.updated : report.added).push(`${rel} (v${srcMeta.version}, ${commit})`);
    }
  }

  // NAM files in dest that the source no longer ships: report, never delete.
  const shipped = new Set(files);
  for (const [dir, keep] of COPY) {
    const abs = path.join(dest, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      const rel = `${dir}/${name}`;
      if (keep(name) && !shipped.has(rel) && fs.statSync(path.join(abs, name)).isFile()) {
        report.stale.push(rel);
      }
    }
  }
  for (const rel of [".nam/Scripts/export.mjs"]) {
    if (fs.existsSync(path.join(dest, rel))) report.stale.push(`${rel} (old export direction; copies the project back over this source repo)`);
  }

  console.log(`NAM install ${args.dryRun ? "(dry run) " : ""}${SRC} -> ${dest}`);
  for (const [k, list] of Object.entries(report)) {
    if (!list.length) continue;
    console.log(`\n${k} (${list.length}):`);
    for (const rel of list) console.log(`  ${rel}`);
  }
  if (!args.dryRun && (report.updated.length || report.merged.length)) {
    console.log(`\nBackups: ${backupRoot}`);
  }
  console.log("\nNext: node .cursor/hooks/nam-cli.mjs doctor (in the project), then reconcile --apply.");
}

try {
  main();
} catch (err) {
  console.error(`install error: ${err.message}`);
  process.exit(1);
}
