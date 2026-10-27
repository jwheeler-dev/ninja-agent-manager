#!/usr/bin/env node
/**
 * Export a clean Ninja Agent Manager (NAM) scaffold for publishing.
 *
 * Copies product files only (guides, commands, hooks, README).
 * Skips project state: Memory logs, Mailbox queues, Runtime, Implementation Plan.
 *
 * Usage (from ninja-master repo root):
 *   node .nam/Scripts/export.mjs
 *   node .nam/Scripts/export.mjs --dest D:\Personal\ninja-agent-manager
 *   node .nam/Scripts/export.mjs --dry-run
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_DEST = "D:\\Personal\\ninja-agent-manager";

function parseArgs(argv) {
  const out = { dest: DEFAULT_DEST, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dest") out.dest = argv[++i];
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function ensureDir(dir, dryRun) {
  if (dryRun) return;
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest, dryRun, stats) {
  if (!fs.existsSync(src)) {
    console.warn(`  skip missing: ${src}`);
    return;
  }
  console.log(`  ${path.relative(REPO_ROOT, src)} -> ${dest}`);
  stats.files++;
  if (dryRun) return;
  ensureDir(path.dirname(dest), false);
  fs.copyFileSync(src, dest);
}

function copyDirFiles(srcDir, destDir, dryRun, stats, filter = () => true) {
  if (!fs.existsSync(srcDir)) {
    console.warn(`  skip missing dir: ${srcDir}`);
    return;
  }
  ensureDir(destDir, dryRun);
  for (const name of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, name);
    if (!fs.statSync(src).isFile()) continue;
    if (!filter(name, src)) continue;
    copyFile(src, path.join(destDir, name), dryRun, stats);
  }
}

function writeText(dest, contents, dryRun, stats) {
  console.log(`  write ${dest}`);
  stats.written++;
  if (dryRun) return;
  ensureDir(path.dirname(dest), false);
  fs.writeFileSync(dest, contents, "utf8");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Export NAM scaffold

Usage:
  node .nam/Scripts/export.mjs [--dest PATH] [--dry-run]

Default --dest: ${DEFAULT_DEST}
`);
    process.exit(0);
  }

  const dest = path.resolve(args.dest);
  const dryRun = args.dryRun;
  const stats = { files: 0, written: 0 };

  console.log(`NAM export`);
  console.log(`  source: ${REPO_ROOT}`);
  console.log(`  dest:   ${dest}`);
  if (dryRun) console.log(`  mode:   dry-run`);
  console.log();

  if (!dryRun) ensureDir(dest, false);

  // --- .nam product ---
  console.log(".nam/");
  copyFile(
    path.join(REPO_ROOT, ".nam", "README.md"),
    path.join(dest, ".nam", "README.md"),
    dryRun,
    stats,
  );
  copyFile(
    path.join(REPO_ROOT, ".nam", "metadata.json"),
    path.join(dest, ".nam", "metadata.json"),
    dryRun,
    stats,
  );
  copyDirFiles(
    path.join(REPO_ROOT, ".nam", "Guides"),
    path.join(dest, ".nam", "Guides"),
    dryRun,
    stats,
    (name) => name.endsWith(".md"),
  );
  copyFile(
    path.join(REPO_ROOT, ".nam", "Mailbox", "README.md"),
    path.join(dest, ".nam", "Mailbox", "README.md"),
    dryRun,
    stats,
  );
  copyFile(
    path.join(REPO_ROOT, ".nam", "Runtime", "README.md"),
    path.join(dest, ".nam", "Runtime", "README.md"),
    dryRun,
    stats,
  );

  // Empty state trees (do not copy live memory / mailbox / runtime JSON)
  writeText(path.join(dest, ".nam", "Mailbox", ".gitkeep"), "", dryRun, stats);
  writeText(path.join(dest, ".nam", "Memory", ".gitkeep"), "", dryRun, stats);
  writeText(
    path.join(dest, ".nam", "Memory", "Handovers", ".gitkeep"),
    "",
    dryRun,
    stats,
  );
  writeText(path.join(dest, ".nam", "Runtime", ".gitkeep"), "", dryRun, stats);

  // --- .cursor product ---
  console.log(".cursor/");
  copyDirFiles(
    path.join(REPO_ROOT, ".cursor", "commands"),
    path.join(dest, ".cursor", "commands"),
    dryRun,
    stats,
    (name) => name.startsWith("nam-") && name.endsWith(".md"),
  );
  copyDirFiles(
    path.join(REPO_ROOT, ".cursor", "hooks"),
    path.join(dest, ".cursor", "hooks"),
    dryRun,
    stats,
    (name) => name.startsWith("nam-") && name.endsWith(".mjs"),
  );
  copyFile(
    path.join(REPO_ROOT, ".cursor", "hooks.json"),
    path.join(dest, ".cursor", "hooks.json"),
    dryRun,
    stats,
  );

  // Optional skill
  const skillSrc = path.join(REPO_ROOT, ".cursor", "skills", "nam-migration", "SKILL.md");
  if (fs.existsSync(skillSrc)) {
    copyFile(
      skillSrc,
      path.join(dest, ".cursor", "skills", "nam-migration", "SKILL.md"),
      dryRun,
      stats,
    );
  }

  // Root helpers for the published repo
  writeText(
    path.join(dest, ".gitignore"),
    `# NAM local / ephemeral state (do not publish project runs)
.nam/Memory/**
!.nam/Memory/.gitkeep
!.nam/Memory/Handovers/.gitkeep
.nam/Mailbox/Agent_*/
.nam/Runtime/**
!.nam/Runtime/.gitkeep
!.nam/Runtime/README.md
.nam/Implementation_Plan.md
.nam/Manager_Bootstrap_Prompt.md

# OS / editor
.DS_Store
Thumbs.db
*.log
`,
    dryRun,
    stats,
  );

  // GitHub shows the root README; keep it in sync with .nam/README.md
  const namReadme = fs.readFileSync(
    path.join(REPO_ROOT, ".nam", "README.md"),
    "utf8",
  );
  writeText(path.join(dest, "README.md"), namReadme, dryRun, stats);

  console.log();
  console.log(
    `Done. Copied ${stats.files} file(s), wrote ${stats.written} generated file(s).`,
  );
  if (!dryRun) {
    console.log(`Open: ${dest}`);
  }
}

main();
