/**
 * manager.js — orchestration layer.
 *
 * A "pane" is a persistent review environment: one worktree + one dev
 * server on its own port. Panes are reused across branch switches; the
 * expensive parts (worktree creation, dependency install) happen only when
 * needed. The user's own working tree is read-only territory: we list its
 * branches and copy configured env files out of it, and that is all.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";

import * as gitops from "./gitops.js";
import { lockfileHash, runInstall } from "./install.js";
import { allocatePort, DevServer } from "./processes.js";
import { FrameProxy } from "./proxy.js";
import { paneUrl, projectDataDir } from "./config.js";

export class Manager extends EventEmitter {
  constructor({ repoRoot, config }) {
    super();
    this.repoRoot = repoRoot;
    this.config = config;
    // Set by the Daemon once it knows its own port. Panes need it only to
    // answer "would this app let the shell embed it?" — see probeFraming().
    this.daemonPort = null;
    this.dataDir = projectDataDir(repoRoot);
    this.panes = new Map(); // id -> pane
    this.takenPorts = new Set();
    this.queue = Promise.resolve(); // serialize mutating operations
  }

  emitEvent(type, payload = {}) {
    this.emit("event", { type, at: Date.now(), ...payload });
  }

  /** Serialize mutations so concurrent widget clicks can't interleave git ops. */
  run(fn) {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  paneDir(id) {
    return path.join(this.dataDir, "panes", id);
  }

  async state() {
    const [branch, head, branches] = await Promise.all([
      gitops.currentBranch(this.repoRoot),
      gitops.headCommit(this.repoRoot),
      gitops.listBranches(this.repoRoot),
    ]);
    return {
      repo: this.repoRoot,
      main: { branch, head },
      branches,
      panes: [...this.panes.values()].map(paneInfo),
    };
  }

  async fetch() {
    this.emitEvent("fetch:start");
    await gitops.fetchAll(this.repoRoot);
    this.emitEvent("fetch:done");
  }

  /**
   * Ensure a pane exists and is serving `branch`. This is the core loop:
   * worktree → checkout → conditional install → (re)start server → ready.
   */
  ensurePane(id, branch, { discard = false } = {}) {
    if (!/^[ab12]$/.test(id)) throw Object.assign(new Error("Pane id must be one of a/b"), { code: "EBADPANE" });
    return this.run(async () => {
      await gitops.assertValidBranchName(this.repoRoot, branch);
      let pane = this.panes.get(id);
      const dir = pane?.dir ?? this.paneDir(id);
      const dirExists = await fs.access(dir).then(() => true, () => false);

      if (!pane || !dirExists) {
        await fs.mkdir(path.dirname(dir), { recursive: true });
        const worktrees = await gitops.listWorktrees(this.repoRoot);
        let existing = await gitops.findWorktree(worktrees, dir);
        // Registered but gone from disk (a crash, a hand-run rm -rf): without
        // healing, git runs with a missing cwd and dies with a misleading
        // "spawn git ENOENT". Prune the stale registration and recreate.
        if (existing && !dirExists) {
          this.emitEvent("pane:healing", { pane: id });
          await gitops.pruneWorktrees(this.repoRoot);
          existing = null;
        }
        if (!existing) {
          this.emitEvent("pane:creating", { pane: id, branch });
          await gitops.addWorktree(this.repoRoot, dir, branch);
          await this.copyEnvFiles(dir);
        }
        if (pane && !dirExists) {
          // The old server's cwd is gone; so is node_modules. Start over.
          await pane.server?.stop().catch(() => {});
          await pane.viewProxy?.stop().catch(() => {});
          if (pane.server) this.takenPorts.delete(pane.server.port);
          if (pane.viewProxy) this.takenPorts.delete(pane.viewProxy.port);
          pane.server = null;
          pane.viewProxy = null;
          pane.installedHash = null;
        }
        if (!pane) {
          pane = {
            id, dir, branch: null, head: null,
            server: null, installedHash: null, status: "new", error: null,
            installLog: [], // raw install stdout/stderr, retained for GET /api/pane/:id/log
          };
          this.panes.set(id, pane);
        }
      }

      try {
        pane.error = null;
        pane.status = "switching";
        this.emitEvent("pane:switching", { pane: id, branch });
        pane.head = await gitops.checkoutInWorktree(this.repoRoot, pane.dir, branch, { discard });
        pane.branch = branch;

        const hash = await lockfileHash(pane.dir, this.config.lockfiles);
        const needsInstall = hash !== pane.installedHash;
        if (needsInstall) {
          pane.status = "installing";
          pane.installLog = [];
          this.emitEvent("pane:installing", { pane: id, branch });
          await runInstall(pane.dir, this.config.install, {
            ring: pane.installLog,
            onOutput: (chunk) => this.emitEvent("pane:install-output", { pane: id, chunk: chunk.slice(0, 2000) }),
          });
          pane.installedHash = hash;
        }

        if (!pane.server) {
          const port = await allocatePort(this.config.basePort, this.takenPorts);
          this.takenPorts.add(port);
          pane.server = new DevServer({
            command: this.config.dev,
            cwd: pane.dir,
            port,
            env: this.config.env,
            readyPath: this.config.ready.path,
            readyStatuses: this.config.ready.statuses,
            daemonPort: this.daemonPort,
            paneOrigin: this.config.paneOrigin,
          });
        }
        if (!pane.viewProxy && this.config.frameProxy) {
          const viewPort = await allocatePort(this.config.basePort, this.takenPorts);
          this.takenPorts.add(viewPort);
          pane.viewProxy = await new FrameProxy({ port: viewPort, targetPort: pane.server.port }).start();
        }

        pane.status = "starting";
        this.emitEvent("pane:starting", { pane: id, branch, port: pane.server.port });
        if (pane.server.state === "ready" && !needsInstall) {
          // Dev server keeps running; its watcher sees the checkout. HMR or
          // full reload is the frontend's job — nothing for us to do.
        } else if (pane.server.state === "ready" && needsInstall) {
          await pane.server.restart();
        } else {
          await pane.server.start();
        }

        pane.status = "ready";
        this.emitEvent("pane:ready", { pane: id, branch, port: pane.server.port });
        return paneInfo(pane);
      } catch (err) {
        pane.status = "error";
        pane.error = err.message;
        this.emitEvent("pane:error", { pane: id, branch, error: err.message, code: err.code });
        throw err;
      }
    });
  }

  async stopPane(id) {
    return this.run(async () => {
      const pane = this.panes.get(id);
      if (!pane) return;
      await pane.server?.stop();
      await pane.viewProxy?.stop();
      if (pane.server) this.takenPorts.delete(pane.server.port);
      if (pane.viewProxy) this.takenPorts.delete(pane.viewProxy.port);
      pane.server = null;
      pane.viewProxy = null;
      pane.status = "stopped";
      this.emitEvent("pane:stopped", { pane: id });
    });
  }

  async destroyPane(id) {
    await this.stopPane(id);
    return this.run(async () => {
      const pane = this.panes.get(id);
      if (!pane) return;
      try { await gitops.removeWorktree(this.repoRoot, pane.dir); } catch { /* best effort */ }
      this.panes.delete(id);
      this.emitEvent("pane:destroyed", { pane: id });
    });
  }

  async shutdown() {
    for (const id of this.panes.keys()) {
      const pane = this.panes.get(id);
      await pane.server?.stop().catch(() => {});
      await pane.viewProxy?.stop().catch(() => {});
    }
  }

  /**
   * Full-detail diagnostics for a pane: raw install output plus the dev
   * server's own stdout/stderr ring, both untouched (real newlines kept)
   * unlike the collapsed single-line tail baked into `pane.error`. Returns
   * null for an unknown pane so the route can 404 instead of guessing.
   */
  getPaneLog(id, { maxChars = 20_000 } = {}) {
    const pane = this.panes.get(id);
    if (!pane) return null;
    const clip = (s) => (s.length > maxChars ? s.slice(-maxChars) : s);
    return {
      pane: id,
      status: pane.status,
      error: pane.error,
      install: clip(pane.installLog.join("")),
      server: clip((pane.server?.logRing ?? []).join("")),
    };
  }

  /** Copy configured untracked files (e.g. .env) from the main tree. */
  async copyEnvFiles(dir) {
    for (const rel of this.config.copy) {
      const src = path.join(this.repoRoot, rel);
      const dst = path.join(dir, rel);
      try {
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.copyFile(src, dst);
      } catch { /* absent — fine */ }
    }
  }
}

function paneInfo(p) {
  return {
    id: p.id,
    branch: p.branch,
    head: p.head,
    status: p.status,
    error: p.error,
    port: p.server?.port ?? null,
    serverState: p.server?.state ?? "stopped",
    framing: p.server?.framing ?? null,
    url: p.server ? paneUrl(p.server.paneOrigin, p.server.port) : null,
    viewUrl: p.viewProxy ? `http://localhost:${p.viewProxy.port}/` : null,
  };
}
