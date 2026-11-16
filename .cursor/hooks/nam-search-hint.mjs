#!/usr/bin/env node
/**
 * PreToolUse (Claude Code, matcher "Grep|Glob") — point code searches at the base code map.
 *
 * base's own PreToolUse hook hints on shell grep/rg/find and PowerShell
 * Select-String, but not on Claude Code's built-in Grep and Glob tools, which
 * Claude Code prefers. This adds the same hint for those tools.
 *
 * Advisory only: it adds context and never blocks the call. Reads files only
 * (no base process), so it stays fast. Silent when NAM_BASE=off, when no code
 * map covers the project, or when the search targets docs, config or
 * dot-directories (which the map does not cover).
 */
import { baseDisabled, codeMapPath } from "./nam-base.mjs";
import { emit, normalizeHookInput, readStdin } from "./nam-lib.mjs";

const NON_CODE_EXT = /\.(md|mdx|txt|log|json|jsonc|ya?ml|toml|ini|env|lock|csv|svg|html?)\b/i;
const NON_CODE_TYPES = new Set(["md", "markdown", "json", "yaml", "toml", "txt", "log", "csv", "html"]);
const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:[.:#][A-Za-z_$][\w$]*)*$/;

function targetsNonCode(toolInput) {
  // Grep filters files with `glob`; Glob's `pattern` is itself the file glob.
  const fileGlob = String((toolInput.tool_name === "Glob" ? toolInput.pattern : toolInput.glob) || "");
  const where = [toolInput.path, fileGlob].filter((v) => typeof v === "string").join(" ");
  if (/(^|[\\/\s])\.[^\\/\s.]/.test(where)) return true; // dot-directory or dotfile
  if (NON_CODE_EXT.test(fileGlob)) return true;
  if (toolInput.type && NON_CODE_TYPES.has(String(toolInput.type).toLowerCase())) return true;
  return false;
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
  if (
    (toolName === "Grep" || toolName === "Glob") &&
    !baseDisabled() &&
    !targetsNonCode(toolInput) &&
    codeMapPath()
  ) {
    emit({ additional_context: hintFor(toolName, toolInput) }, "PreToolUse");
  } else {
    emit({});
  }
} catch {
  emit({}); // a hint must never break a tool call
}
