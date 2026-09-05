/**
 * cli.js — `sidebranch init | start | stop | clean | doctor`
 */

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { loadConfig, CONFIG_FILENAME, DEFAULTS, projectDataDir } from "./config.js";
import { resolvesToLoopbackOnly } from "./security.js";
import * as gitops from "./gitops.js";
import { Manager } from "./manager.js";
import { Daemon } from "./daemon.js";
import { readRecord, writeRecord, clearRecord, stopDaemon, daemonFilePath } from "./daemonfile.js";

const HELP = `sidebranch — local PR review sidecar

Usage:
  sidebranch init            Write a starter ${CONFIG_FILENAME} in this repo
  sidebranch start [--port]  Start the daemon (default port 49400)
  sidebranch stop            Stop the daemon running for this repo
  sidebranch clean [--pane a|b] [--yes]
                              Remove stale pane worktrees for this repo
  sidebranch doctor          Check environment and configuration
  sidebranch help

Then add to your app (dev builds only):
  <script src="http://localhost:49400/widget.js" defer></script>
`;

export async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "init":   return init();
    case "start":  return start(parseFlags(rest));
    case "stop":   return stop();
    case "clean":  return clean(parseCleanFlags(rest));
    case "doctor": return doctor();
    case "help":
    case undefined:
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      return 1;
  }
}

function parseFlags(rest) {
  const flags = { port: 49400 };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--port") flags.port = Number.parseInt(rest[++i], 10);
  }
  if (!Number.isInteger(flags.port) || flags.port < 1024 || flags.port > 65000) {
    throw new Error("--port must be an integer between 1024 and 65000");
  }
  return flags;
}

async function init() {
  const root = await gitops.repoRoot(process.cwd());
  const file = path.join(root, CONFIG_FILENAME);
  try {
    await fs.access(file);
    process.stdout.write(`${CONFIG_FILENAME} already exists at ${root}\n`);
    return 0;
  } catch { /* create it */ }
  const starter = {
    dev: DEFAULTS.dev,
    install: DEFAULTS.install,
    ready: { path: "/" },
  };
  await fs.writeFile(file, JSON.stringify(starter, null, 2) + "\n");
  process.stdout.write(
    `Wrote ${file}\n\n` +
    `Edit "dev" and "install" for your stack. Examples:\n` +
    `  Next.js   { "dev": "npm run dev",              "install": "npm install" }\n` +
    `  Vite      { "dev": "npx vite --port {port}",   "install": "pnpm install" }\n` +
    `  Python    { "dev": "python3 -m http.server {port}", "install": "" }\n\n` +
    `Then run: npx sidebranch start\n`
  );
  return 0;
}

async function start({ port }) {
  const root = await gitops.repoRoot(process.cwd());

  // Two daemons for one repo would fight over the same pane worktrees, and
  // the loser's failure mode is a confusing git lock error rather than
  // anything that names the real cause. Refuse up front instead.
  const existing = await readRecord(root);
  if (existing?.running) {
    process.stderr.write(
      `A sidebranch daemon is already running for this repo.\n` +
      `  pid   ${existing.pid}\n` +
      `  port  ${existing.port}  (http://localhost:${existing.port}/shell)\n\n` +
      `Use that one, or run \`sidebranch stop\` first.\n`
    );
    return 1;
  }
  if (existing && !existing.running) {
    process.stdout.write(
      `Clearing a stale daemon record (pid ${existing.pid}${existing.pidAlive ? ", not answering" : ", gone"}).\n`
    );
    await clearRecord(root);
  }

  const config = await loadConfig(root);
  if (config.paneOrigin && !(await resolvesToLoopbackOnly(config.paneOrigin.hostname))) {
    throw new Error(
      `paneOrigin.hostname "${config.paneOrigin.hostname}" does not resolve to a loopback address. ` +
      `Add it to /etc/hosts pointing at 127.0.0.1, or remove paneOrigin from ${CONFIG_FILENAME}.`
    );
  }
  const manager = new Manager({ repoRoot: root, config });
  const daemon = new Daemon({ manager, port });
  await daemon.start();
  await writeRecord(root, { port });

  process.stdout.write(
    `sidebranch daemon running\n` +
    `  repo      ${root}\n` +
    `  worktrees ${projectDataDir(root)}\n` +
    `  bound     http://127.0.0.1:${port}  (loopback only)\n` +
    `  pid       ${process.pid}  (\`sidebranch stop\` from any terminal)\n\n` +
    `Add to your app (dev only):\n` +
    `  <script src="http://localhost:${port}/widget.js" defer></script>\n\n` +
    `Compare view: open via the widget, or http://localhost:${port}/shell\n`
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; // a second ^C must not race the first
    shuttingDown = true;
    process.stdout.write("\nShutting down panes…\n");
    await daemon.stop().catch(() => {});
    // Only ever clear our own record: if this process somehow outlived its
    // record and another daemon has since claimed the repo, that daemon's
    // record is not ours to delete.
    await clearRecord(root, { onlyIfPid: process.pid });
    process.stdout.write(
      "Panes remain on disk for next time. Run `npx sidebranch clean` to tear down worktrees you no longer need.\n"
    );
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return new Promise(() => {}); // run until signaled
}

/**
 * Stop the daemon serving this repo.
 *
 * SIGTERM only — the daemon's own handler is what stops pane dev servers
 * cleanly, so escalating to SIGKILL would orphan exactly the child processes
 * this command exists to clean up.
 */
async function stop() {
  const root = await gitops.repoRoot(process.cwd());
  const record = await readRecord(root);

  if (!record) {
    process.stdout.write(`No sidebranch daemon recorded for ${root}\n`);
    return 0;
  }
  if (!record.running) {
    // The pid is gone, or something else answers on that port now. Either
    // way the record is a lie; clear it rather than signalling a stranger.
    await clearRecord(root);
    process.stdout.write(
      record.pidAlive
        ? `Cleared a stale record: pid ${record.pid} is alive but is not a sidebranch daemon.\n`
        : `Cleared a stale record: pid ${record.pid} is no longer running.\n`
    );
    return 0;
  }

  process.stdout.write(`Stopping sidebranch daemon (pid ${record.pid}, port ${record.port})…\n`);
  const result = await stopDaemon(record);
  if (!result.ok) {
    process.stderr.write(
      `Daemon ${record.pid} did not exit within 10s. It may be mid-install.\n` +
      `Leaving it alone rather than forcing it — check on it, or kill ${record.pid} yourself.\n`
    );
    return 1;
  }
  await clearRecord(root);
  process.stdout.write(
    result.alreadyGone
      ? "Daemon was already gone; record cleared.\n"
      : "Stopped. Pane worktrees remain on disk — `sidebranch clean` removes them.\n"
  );
  return 0;
}

function parseCleanFlags(rest) {
  const flags = { pane: null, yes: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--pane") flags.pane = rest[++i];
    else if (rest[i] === "--yes" || rest[i] === "-y") flags.yes = true;
  }
  return flags;
}

/**
 * Panes are worktrees that outlive the daemon — this walks the on-disk pane
 * directories for the current repo and cross-references `git worktree list`
 * to report what's there, without requiring a running daemon.
 */
async function findPanes(root, paneFilter) {
  const panesRoot = path.join(projectDataDir(root), "panes");
  let entries;
  try {
    entries = await fs.readdir(panesRoot, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const worktrees = await gitops.listWorktrees(root);
  const rows = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const dir = path.join(panesRoot, e.name);
        const wt = await gitops.findWorktree(worktrees, dir);
        const label = wt ? (wt.branch ?? `detached @ ${(wt.head ?? "").slice(0, 7)}`) : "not a worktree";
        return { id: e.name, dir, tracked: Boolean(wt), label };
      })
  );
  return paneFilter ? rows.filter((r) => r.id === paneFilter) : rows;
}

async function clean({ pane, yes }) {
  const root = await gitops.repoRoot(process.cwd());

  // clean used to be blind here, and the README had to carry the warning in
  // prose. Removing a worktree out from under a running dev server leaves a
  // process serving a directory that no longer exists — refuse instead.
  const record = await readRecord(root);
  if (record?.running) {
    process.stderr.write(
      `A sidebranch daemon is running for this repo (pid ${record.pid}, port ${record.port}).\n` +
      `Removing its worktrees now would leave pane dev servers running against\n` +
      `deleted directories. Run \`sidebranch stop\` first.\n`
    );
    return 1;
  }

  const rows = await findPanes(root, pane);

  if (pane && rows.length === 0) {
    process.stderr.write(`No pane "${pane}" found for ${root}\n`);
    return 1;
  }
  if (rows.length === 0) {
    process.stdout.write(`No panes found for ${root}\n`);
    return 0;
  }

  process.stdout.write(`Panes for ${root}:\n`);
  for (const r of rows) process.stdout.write(`  ${r.id}   ${r.label}   ${r.dir}\n`);
  process.stdout.write(
    "\nThis removes the worktree(s) listed above; nothing else is touched.\n\n"
  );

  if (!yes) {
    if (!process.stdin.isTTY) {
      process.stderr.write(`Re-run with --yes to remove ${rows.length === 1 ? "this pane" : "these panes"}.\n`);
      return 1;
    }
    const ok = await confirm(`Remove ${rows.length} pane${rows.length === 1 ? "" : "s"}? [y/N] `);
    if (!ok) {
      process.stdout.write("Aborted.\n");
      return 1;
    }
  }

  let failures = 0;
  for (const r of rows) {
    try {
      if (r.tracked) await gitops.removeWorktree(root, r.dir);
      else await fs.rm(r.dir, { recursive: true, force: true });
      process.stdout.write(`removed ${r.id} (${r.label})\n`);
    } catch (err) {
      failures++;
      process.stderr.write(`failed to remove ${r.id}: ${err.message}\n`);
    }
  }
  return failures === 0 ? 0 : 1;
}

function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function doctor() {
  const checks = [];
  const push = (name, ok, note = "") => checks.push({ name, ok, note });

  try {
    const root = await gitops.repoRoot(process.cwd());
    push("git repository", true, root);
    try {
      const cfg = await loadConfig(root);
      const origin = cfg.paneOrigin ? `  panes=${cfg.paneOrigin.scheme}://${cfg.paneOrigin.hostname}` : "";
      push(`${CONFIG_FILENAME}`, true, `dev="${cfg.dev}"  install="${cfg.install}"${origin}`);
    } catch (e) {
      push(CONFIG_FILENAME, false, e.message);
    }
  } catch {
    push("git repository", false, "run inside a git repo");
  }
  push("node version", Number(process.versions.node.split(".")[0]) >= 20, process.versions.node);

  try {
    const root = await gitops.repoRoot(process.cwd());
    const record = await readRecord(root);
    if (!record) push("daemon", true, "not running");
    else if (record.running) push("daemon", true, `running — pid ${record.pid}, port ${record.port}`);
    else {
      // Not a failure: a stale record is self-healing, both `start` and
      // `stop` clear it. Say so rather than reporting a scary FAIL.
      push("daemon", true, `stale record (pid ${record.pid} ${record.pidAlive ? "not answering" : "gone"}) — \`sidebranch stop\` clears it`);
    }
  } catch { /* not a git repo; already reported above */ }

  try {
    const root = await gitops.repoRoot(process.cwd());
    const paneRoot = path.join(projectDataDir(root), "panes") + path.sep;
    const stale = [];
    for (const w of await gitops.listWorktrees(root)) {
      if (!w.path.startsWith(paneRoot)) continue;
      const gone = await fs.access(w.path).then(() => false, () => true);
      if (gone) stale.push(path.basename(w.path));
    }
    // Informational, not a failure: ensurePane prunes and recreates these.
    if (stale.length) push("pane worktrees", true, `stale registration for pane ${stale.join(", ")} — auto-healed on next use`);
  } catch { /* not a git repo; already reported above */ }

  for (const c of checks) {
    process.stdout.write(`${c.ok ? " ok " : "FAIL"}  ${c.name}${c.note ? ` — ${c.note}` : ""}\n`);
  }
  return checks.every((c) => c.ok) ? 0 : 1;
}
