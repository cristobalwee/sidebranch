/**
 * config.js — project configuration (.sidebranch.json at the repo root).
 *
 * The config is authored by the repo owner and is trusted exactly like the
 * repo's own package.json scripts: it can name commands to run in dev, and
 * nothing else. It cannot change the daemon's bind address, disable auth,
 * or widen origins — those are not configuration, they are invariants.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { DEFAULT_LOCKFILES } from "./install.js";

export const CONFIG_FILENAME = ".sidebranch.json";

export const DEFAULTS = {
  dev: "npm run dev",             // command to start the app in a worktree
  install: "npm install",         // run when lockfiles change
  ready: { path: "/", statuses: null }, // readiness probe; null = any HTTP answer
  panes: 2,                        // review worktrees kept warm
  basePort: 4410,                  // first port tried for pane servers
  lockfiles: DEFAULT_LOCKFILES,    // manifests that trigger reinstall
  copy: [".env", ".env.local"],    // untracked files copied from main tree into new worktrees
  env: {},                         // extra env vars injected into the pane dev command
  widget: true,                    // set false to make /widget.js serve a no-op
  frameProxy: true,                // set false to disable the compare view's header-stripping view ports
  paneOrigin: null,                // { scheme, hostname } a pane dev server answers on; null = http://localhost
};

// Env names sidebranch owns and injects itself (see processes.js). Config
// `env` can override anything *except* these — letting a project clobber PORT
// would break the per-pane port injection the whole tool is built on.
export const RESERVED_ENV = new Set(["PORT", "BROWSER", "FORCE_COLOR", "SIDEBRANCH"]);

export async function loadConfig(repoRoot) {
  const file = path.join(repoRoot, CONFIG_FILENAME);
  let raw = {};
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Could not parse ${CONFIG_FILENAME}: ${err.message}`);
    }
  }
  return normalize(raw);
}

export function normalize(raw) {
  const cfg = { ...DEFAULTS, ...raw };
  cfg.ready = { ...DEFAULTS.ready, ...(raw.ready || {}) };
  if (typeof cfg.dev !== "string" || !cfg.dev.trim()) throw new Error(`"dev" must be a command string`);
  if (typeof cfg.install !== "string") throw new Error(`"install" must be a command string`);
  cfg.panes = clampInt(cfg.panes, 1, 4, DEFAULTS.panes);
  cfg.basePort = clampInt(cfg.basePort, 1024, 65000, DEFAULTS.basePort);
  if (!Array.isArray(cfg.lockfiles)) cfg.lockfiles = DEFAULT_LOCKFILES;
  if (!Array.isArray(cfg.copy)) cfg.copy = DEFAULTS.copy;
  cfg.copy = cfg.copy.filter((f) => typeof f === "string" && !f.includes("..") && !path.isAbsolute(f));
  cfg.env = normalizeEnv(cfg.env);
  cfg.widget = cfg.widget !== false;
  cfg.paneOrigin = normalizePaneOrigin(cfg.paneOrigin);
  if (cfg.paneOrigin && raw.frameProxy === true) {
    throw new Error(`"frameProxy" cannot be true alongside "paneOrigin": view ports serve on localhost and cannot preserve a custom origin`);
  }
  cfg.frameProxy = cfg.frameProxy !== false && cfg.paneOrigin === null;
  if (cfg.ready.statuses !== null && !Array.isArray(cfg.ready.statuses)) cfg.ready.statuses = null;
  if (typeof cfg.ready.path !== "string" || !cfg.ready.path.startsWith("/")) cfg.ready.path = "/";
  return cfg;
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function normalizePaneOrigin(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`"paneOrigin" must be an object with "scheme" and "hostname"`);
  }
  const scheme = raw.scheme ?? "http";
  if (scheme !== "http" && scheme !== "https") {
    throw new Error(`"paneOrigin.scheme" must be "http" or "https", got ${JSON.stringify(raw.scheme)}`);
  }
  const hostname = typeof raw.hostname === "string" ? raw.hostname.trim().toLowerCase() : "";
  if (!HOSTNAME.test(hostname)) {
    throw new Error(`"paneOrigin.hostname" must be a hostname, got ${JSON.stringify(raw.hostname)}`);
  }
  return { scheme, hostname };
}

export function paneUrl(paneOrigin, port) {
  const { scheme, hostname } = paneOrigin ?? { scheme: "http", hostname: "localhost" };
  return `${scheme}://${hostname}:${port}/`;
}

/**
 * Coerce a config `env` block into a clean { NAME: "value" } map.
 *
 * - Keys must be POSIX-portable env names (`[A-Za-z_][A-Za-z0-9_]*`); anything
 *   else is dropped rather than passed to spawn where it could misbehave.
 * - Reserved names sidebranch injects itself (PORT etc.) are dropped so config
 *   can never break port injection.
 * - String values pass through **including the empty string** — setting a var
 *   to "" is a deliberate, supported way to unset an inherited value (e.g.
 *   GOOGLE_APPLICATION_CREDENTIALS="" to fall back to machine ADC).
 * - Numbers/booleans are coerced to strings for author convenience; objects,
 *   arrays, null, and values containing NUL are dropped (spawn can't take them).
 */
export function normalizeEnv(raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (RESERVED_ENV.has(key)) continue;
    let s;
    if (typeof val === "string") s = val;
    else if (typeof val === "number" || typeof val === "boolean") s = String(val);
    else continue;
    if (s.includes("\0")) continue;
    out[key] = s;
  }
  return out;
}

function clampInt(v, min, max, dflt) {
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/** Where sidebranch keeps worktrees and runtime state, outside the repo. */
export function dataDir() {
  return process.env.SIDEBRANCH_HOME || path.join(os.homedir(), ".sidebranch");
}

export function projectDataDir(repoRoot) {
  const slug = path.basename(repoRoot).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  const hash = simpleHash(repoRoot).slice(0, 8);
  return path.join(dataDir(), "projects", `${slug}-${hash}`);
}

function simpleHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
