/**
 * nam-ponytail — NAM's check for ponytail, the coding-discipline ruleset
 * (https://github.com/DietrichGebert/ponytail).
 *
 * - Claude Code: the ponytail plugin injects the ruleset into every session
 *   and subagent and adds /ponytail-review, /ponytail-debt and friends.
 * - Cursor: the always-on rule .cursor/rules/ponytail.mdc, which the NAM
 *   installer copies into each project (vendored at .nam/Vendor/ponytail/).
 *
 * Warn-only, like nam-base: reads a few files, never spawns, never throws.
 * Each warning is `<host>: <problem> → fix: <command>`. NAM_PONYTAIL=off skips it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectRoot, readJson, readText } from "./nam-lib.mjs";

const PLUGIN = "ponytail@ponytail";
const RULE = ".cursor/rules/ponytail.mdc";

export function ponytailDisabled() {
  return ["off", "0", "false", "no"].includes(
    String(process.env.NAM_PONYTAIL ?? "").trim().toLowerCase(),
  );
}

function samePath(a, b) {
  const norm = (p) => path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

function claudeCode(root) {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const plugins = readJson(path.join(dir, "plugins", "installed_plugins.json"), null)?.plugins || {};
  const key = Object.keys(plugins).find((k) => k.split("@")[0] === "ponytail") || PLUGIN;
  // Project- and local-scope installs only count in their own project.
  const installs = [].concat(plugins[key] || []).filter(
    (i) => i && (i.scope === "user" || !i.projectPath || samePath(i.projectPath, root)),
  );
  // enabledPlugins: local settings beat project settings beat user settings.
  let enabled = false;
  for (const file of [
    path.join(dir, "settings.json"),
    path.join(root, ".claude", "settings.json"),
    path.join(root, ".claude", "settings.local.json"),
  ]) {
    const v = readJson(file, null)?.enabledPlugins?.[key];
    if (typeof v === "boolean") enabled = v;
  }
  return {
    key,
    installed: installs.length > 0,
    enabled: installs.length > 0 && enabled,
    version: installs[0]?.version || null,
  };
}

/**
 * Where ponytail is active for this project, and what to fix. Reads only:
 * ~/.claude (or CLAUDE_CONFIG_DIR), the project's .claude settings and Cursor
 * rule, and ~/.cursor/hooks.json.
 */
export function ponytailStatus() {
  if (ponytailDisabled()) {
    return { ok: false, disabled: true, warnings: ["NAM_PONYTAIL=off: ponytail check skipped"] };
  }
  try {
    const root = path.resolve(projectRoot());
    const cc = claudeCode(root);
    const cursor = {
      rule: fs.existsSync(path.join(root, RULE)),
      user_hooks: /ponytail/i.test(readText(path.join(os.homedir(), ".cursor", "hooks.json")) || ""),
    };
    const warnings = [];
    if (!cc.installed) {
      warnings.push(
        "claude_code: ponytail plugin not installed → fix: in Claude Code run `/plugin marketplace add DietrichGebert/ponytail`, then `/plugin install ponytail@ponytail`",
      );
    } else if (!cc.enabled) {
      warnings.push(`claude_code: ponytail plugin installed but not enabled → fix: \`/plugin enable ${cc.key}\``);
    }
    if (!cursor.rule) {
      warnings.push(
        `cursor: ${RULE} missing → fix: re-run the NAM installer from the NAM source repo: node .nam/Scripts/install.mjs --dest "${root.replace(/\\/g, "/")}"`,
      );
    }
    return {
      ok: warnings.length === 0,
      hosts: {
        claude_code: { installed: cc.installed, enabled: cc.enabled, version: cc.version },
        cursor,
      },
      warnings,
    };
  } catch (err) {
    return { ok: false, warnings: [`ponytail check failed: ${err.message}`] };
  }
}
