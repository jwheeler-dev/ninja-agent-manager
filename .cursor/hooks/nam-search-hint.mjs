#!/usr/bin/env node
/**
 * PreToolUse (Claude Code, matcher "Grep|Glob") — point code searches at the base code map.
 *
 * base's own PreToolUse hook hints on shell grep/rg/find and PowerShell
 * Select-String, but not on Claude Code's built-in Grep and Glob tools, which
 * Claude Code prefers. This adds the same hint for those tools.
 *
 * Advisory only: it adds context and never blocks the call. Runs no base
 * process. Silent when NAM_BASE=off, when no code map exists, when the search
 * targets docs or config, and when the map holds no code file under the
 * searched folder (dot-directories, for one: base's AST walker skips them).
 *
 * The map's code-file list is cached in .nam/Runtime/base_map_files.json and
 * rebuilt only when the map file changes, since a map can be tens of MB.
 */
import fs from "node:fs";
import path from "node:path";
import { baseDisabled, codeMapPath } from "./nam-base.mjs";
import { emit, normalizeHookInput, projectRoot, readJson, readStdin, runtimePath } from "./nam-lib.mjs";

const NON_CODE = "md|mdx|txt|log|json|jsonc|ya?ml|toml|ini|env|lock|csv|svg|html?";
const NON_CODE_EXT = new RegExp(`\\.(${NON_CODE})\\b`, "i");
const NON_CODE_FILE = new RegExp(`\\.(${NON_CODE})$`, "i");
const NON_CODE_TYPES = new Set(["md", "markdown", "json", "yaml", "toml", "txt", "log", "csv", "html"]);
const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:[.:#][A-Za-z_$][\w$]*)*$/;
const WILDCARD = /[*?[\]{}]/;

const fold = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
const cleanRel = (p) => String(p || "").replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");

function targetsNonCode(toolInput) {
  // Grep filters files with `glob`; Glob's `pattern` is itself the file glob.
  const fileGlob = String((toolInput.tool_name === "Glob" ? toolInput.pattern : toolInput.glob) || "");
  const where = [toolInput.path, fileGlob].filter((v) => typeof v === "string").join(" ");
  if (/(^|[\\/\s])\.[^\\/\s.]/.test(where)) return true; // dot-directory or dotfile
  if (NON_CODE_EXT.test(fileGlob)) return true;
  if (toolInput.type && NON_CODE_TYPES.has(String(toolInput.type).toLowerCase())) return true;
  return false;
}

/** Code files the map covers, relative to the map's root and `/`-separated. */
function mappedCodeFiles(mapFile) {
  const st = fs.statSync(mapFile);
  const key = `${mapFile}|${st.mtimeMs}|${st.size}`;
  const cacheFile = runtimePath("base_map_files.json");
  const cached = readJson(cacheFile, null);
  if (cached?.key === key && Array.isArray(cached.files)) return cached.files;

  const files = new Set();
  const text = fs.readFileSync(mapFile, "utf8");
  for (const m of text.matchAll(/ops:sourceFile "((?:[^"\\]|\\.)*)"/g)) {
    const raw = m[1].replace(/\\\\/g, "\\");
    if (path.isAbsolute(raw)) continue; // the map's root module
    const rel = cleanRel(raw);
    if (rel && !NON_CODE_FILE.test(rel)) files.add(rel);
  }
  const list = [...files];
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ key, files: list }), "utf8");
  } catch {
    // cache is optional
  }
  return list;
}

/** Extensions a file glob's last segment asks for (`*.ts`, `*.{ts,tsx}`), or null for any. */
function globExts(segment) {
  const set = segment.match(/\.\{([^}]+)\}$/);
  if (set) return set[1].split(",").map((e) => e.trim().replace(/^\./, "").toLowerCase());
  const one = segment.match(/\.([A-Za-z0-9]+)$/);
  return one ? [one[1].toLowerCase()] : null;
}

/** The folder or file a search covers, relative to the map root, plus any extension filter. */
function searchTarget(toolName, input, mapRoot) {
  const start = path.resolve(projectRoot(), String(input.path || "."));
  const rel = path.relative(mapRoot, start);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null; // outside the map
  const glob = String((toolName === "Glob" ? input.pattern : input.glob) || "").replace(/\\/g, "/");
  const segs = glob.split("/");
  const fixed = [];
  for (const s of segs.slice(0, -1)) {
    if (!s || WILDCARD.test(s)) break;
    fixed.push(s);
  }
  return {
    rel: cleanRel([cleanRel(rel), ...fixed].filter(Boolean).join("/")),
    exts: globExts(segs[segs.length - 1] || ""),
  };
}

function covers(files, { rel, exts }) {
  const exact = rel ? fold(rel) : null;
  const prefix = rel ? `${fold(rel)}/` : "";
  return files.some((f) => {
    const ff = fold(f);
    if (ff !== exact && !ff.startsWith(prefix)) return false;
    return !exts || exts.includes(path.extname(f).slice(1).toLowerCase());
  });
}

function hintFor(toolName, toolInput) {
  if (toolName === "Grep") {
    const pattern = String(toolInput.pattern || "").trim();
    if (IDENTIFIER.test(pattern)) {
      return [
        `<nam-ast-hint> A code map covers this search. Try first: base ast query --contains "${pattern}"`,
        `For callers: base ast query --calls "${pattern}". Then read only the lines you need. </nam-ast-hint>`,
      ].join("\n");
    }
  }
  return [
    "<nam-ast-hint> A code map covers this project. For code navigation try base ast query first:",
    "--contains <name>, --file <path>, --calls <name>, --imports <path>. </nam-ast-hint>",
  ].join("\n");
}

try {
  const input = normalizeHookInput(await readStdin().catch(() => ({})));
  const toolName = input.tool_name;
  const toolInput = { ...(input.tool_input || {}), tool_name: toolName };
  const mapFile =
    (toolName === "Grep" || toolName === "Glob") && !baseDisabled() && !targetsNonCode(toolInput)
      ? codeMapPath()
      : null;
  const target = mapFile ? searchTarget(toolName, toolInput, path.dirname(path.dirname(mapFile))) : null;
  if (target && covers(mappedCodeFiles(mapFile), target)) {
    emit({ additional_context: hintFor(toolName, toolInput) }, "PreToolUse");
  } else {
    emit({});
  }
} catch {
  emit({}); // a hint must never break a tool call
}
