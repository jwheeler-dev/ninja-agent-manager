#!/usr/bin/env node
/**
 * NAM notify — sends a Pushover notification to the project owner.
 *
 * Usage:
 *   node .cursor/hooks/nam-notify.mjs --kind progress|input --title TEXT --message TEXT [--url URL] [--url-title TEXT]
 *   node .cursor/hooks/nam-notify.mjs --validate
 *
 * `progress` = normal priority (a task finished, a phase closed).
 * `input`    = high priority (the owner must approve, run a command, or test something).
 *
 * Credentials are never stored in the repo. They come from env PUSHOVER_APP_TOKEN /
 * PUSHOVER_USER_KEY when set, otherwise from Google Secret Manager (`pushover-app-token`,
 * `pushover-user-key`) through the gcloud configuration in NAM_NOTIFY_GCLOUD_CONFIG
 * (default `mygeartracker-staging`). Secret values are never printed.
 */
import { execSync } from "node:child_process";

const API = "https://api.pushover.net/1";
const TITLE_MAX = 250;
const MESSAGE_MAX = 1024;
const PRIORITY = { progress: 0, input: 1 };

function usage(code = 1) {
  process.stderr.write(
    "Usage: nam-notify.mjs --kind progress|input --title TEXT --message TEXT [--url URL] [--url-title TEXT]\n" +
      "       nam-notify.mjs --validate\n",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) usage();
    const name = key.slice(2);
    if (name === "validate" || name === "help") {
      args[name] = true;
    } else {
      args[name] = argv[++i];
      if (args[name] === undefined) usage();
    }
  }
  return args;
}

function readSecret(name) {
  const config = process.env.NAM_NOTIFY_GCLOUD_CONFIG || "mygeartracker-staging";
  if (!/^[a-z0-9-]+$/.test(config)) throw new Error("Invalid NAM_NOTIFY_GCLOUD_CONFIG");
  // One fixed command string: no user input reaches the shell.
  return execSync(
    `gcloud --configuration=${config} secrets versions access latest --secret=${name}`,
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function credentials() {
  const token = process.env.PUSHOVER_APP_TOKEN || readSecret("pushover-app-token");
  const user = process.env.PUSHOVER_USER_KEY || readSecret("pushover-user-key");
  return { token, user };
}

async function post(endpoint, fields) {
  const res = await fetch(`${API}/${endpoint}`, {
    method: "POST",
    body: new URLSearchParams(fields),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status !== 1) {
    const errors = Array.isArray(body.errors) ? body.errors.join("; ") : `HTTP ${res.status}`;
    throw new Error(`Pushover ${endpoint} failed: ${errors}`);
  }
  return body;
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) usage(0);

  let creds;
  try {
    creds = credentials();
  } catch {
    console.error(
      "Could not read Pushover credentials (env PUSHOVER_APP_TOKEN/PUSHOVER_USER_KEY or Secret Manager).",
    );
    process.exit(2);
  }

  if (args.validate) {
    await post("users/validate.json", { token: creds.token, user: creds.user });
    console.log(JSON.stringify({ ok: true, validated: true }));
    return;
  }

  const kind = args.kind ?? "progress";
  if (!(kind in PRIORITY) || !args.title || !args.message) usage();

  const fields = {
    token: creds.token,
    user: creds.user,
    title: clip(args.title, TITLE_MAX),
    message: clip(args.message.replace(/\\n/g, "\n"), MESSAGE_MAX),
    priority: String(PRIORITY[kind]),
  };
  if (args.url) fields.url = args.url;
  if (args["url-title"]) fields.url_title = args["url-title"];

  const body = await post("messages.json", fields);
  console.log(JSON.stringify({ ok: true, kind, request: body.request }));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
