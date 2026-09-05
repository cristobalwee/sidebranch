/**
 * processes.js — spawn and supervise one dev server per review worktree.
 *
 * Framework-agnostic contract: a dev server is (command, cwd, port, env) plus
 * a readiness probe. We inject the allocated port as the PORT env var and
 * substitute a literal {port} placeholder in the command for tools that
 * only take a flag (e.g. "vite --port {port}", "python3 -m http.server {port}").
 * Config-supplied `env` is layered on top of the inherited environment (so a
 * project can point a pane at a shared emulator, unset a stale credential
 * path, etc.) but cannot override the vars sidebranch owns — PORT above all.
 * We never parse dev-server output — readiness is confirmed by probing the
 * port, because some servers silently pick a different port than asked.
 */

import net from "node:net";
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";

import { splitCommand, tailText } from "./install.js";
import { isValidPort } from "./security.js";

/** Find a free port on loopback, preferring sequential ports from `base`. */
export async function allocatePort(base = 4410, taken = new Set()) {
  for (let p = base; p < base + 500; p++) {
    if (taken.has(p)) continue;
    if (await portIsFree(p)) return p;
  }
  throw new Error("No free ports available in range");
}

export function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

export function probeGet(paneOrigin, options, onResponse) {
  if (paneOrigin?.scheme !== "https") return http.get({ host: "127.0.0.1", ...options }, onResponse);
  return https.get(
    { host: "127.0.0.1", servername: paneOrigin.hostname, rejectUnauthorized: false, ...options },
    onResponse
  );
}

/**
 * Probe an HTTP endpoint until it answers or timeout.
 * Any HTTP status counts as "up" by default — a 404 or 500 still proves the
 * server is accepting connections; which statuses count is configurable.
 */
export function waitForReady({ port, path: probePath = "/", statuses = null, timeoutMs = 120_000, intervalMs = 400, signal, paneOrigin = null }) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (signal?.aborted) return reject(new Error("aborted"));
      const req = probeGet(
        paneOrigin,
        { port, path: probePath, timeout: 3000 },
        (res) => {
          res.resume();
          const ok = statuses ? statuses.includes(res.statusCode) : true;
          if (ok) return resolve(res.statusCode);
          retry();
        }
      );
      req.on("timeout", () => { req.destroy(); retry(); });
      req.on("error", retry);
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error(`Server on :${port} not ready after ${timeoutMs / 1000}s`));
      setTimeout(attempt, intervalMs);
    };
    attempt();
  });
}

/**
 * Ask a pane's dev server whether it will allow itself to be embedded.
 *
 * `/shell` frames panes from a *different* origin — the daemon is on 49400,
 * panes are on 4410+ — and same-origin is per-port, so any app that sends
 * `X-Frame-Options: SAMEORIGIN` (or a `frame-ancestors` that excludes the
 * daemon) refuses to render there. The browser reports that only as a console
 * message inside the frame, which the shell cannot read cross-origin, so
 * without this probe the compare view is simply, silently blank.
 *
 * Best-effort by construction: `frame-ancestors` is a source-list grammar and
 * this does not implement it. It answers "will this obviously refuse?", which
 * is enough to replace a blank rectangle with a sentence naming the header.
 * Never throws — an unreachable server is not a framing verdict.
 */
export function probeFraming({ port, path: probePath = "/", daemonPort, paneOrigin = null }) {
  return new Promise((resolve) => {
    const done = (v) => resolve(v);
    const req = probeGet(
      paneOrigin,
      { port, path: probePath, timeout: 3000 },
      (res) => {
        res.resume();
        done(readFramingHeaders(res.headers, daemonPort));
      }
    );
    req.on("timeout", () => { req.destroy(); done(null); });
    req.on("error", () => done(null));
  });
}

export function readFramingHeaders(headers, daemonPort) {
  const xfo = String(headers["x-frame-options"] ?? "").trim().toLowerCase();
  if (xfo === "deny" || xfo === "sameorigin") {
    return { blocked: true, header: "X-Frame-Options", value: xfo.toUpperCase() };
  }
  const csp = String(headers["content-security-policy"] ?? "");
  const directive = /(?:^|;)\s*frame-ancestors\s+([^;]+)/i.exec(csp);
  if (!directive) return { blocked: false, header: null, value: null };
  const sources = directive[1].trim().toLowerCase().split(/\s+/);
  const permits = sources.some((src) => (
    src === "*" ||
    src === `http://localhost:${daemonPort}` ||
    src === `http://127.0.0.1:${daemonPort}` ||
    src === "http://localhost:*" ||
    src === "http://127.0.0.1:*"
  ));
  return permits
    ? { blocked: false, header: null, value: null }
    : { blocked: true, header: "Content-Security-Policy", value: `frame-ancestors ${directive[1].trim()}` };
}

export class DevServer {
  constructor({ command, cwd, port, env = {}, readyPath = "/", readyStatuses = null, daemonPort = null, paneOrigin = null }) {
    if (!isValidPort(port)) throw new Error(`Invalid port ${port}`);
    this.command = command;
    this.cwd = cwd;
    this.port = port;
    this.env = env;
    this.readyPath = readyPath;
    this.readyStatuses = readyStatuses;
    this.daemonPort = daemonPort;
    this.paneOrigin = paneOrigin;
    this.child = null;
    this.state = "stopped"; // stopped | starting | ready | crashed
    this.logRing = [];
    this.exitInfo = null;
    // null until the readiness probe has had a chance to look — "unknown",
    // which the shell renders as "embed it and see", not as "blocked".
    this.framing = null;
  }

  log(line) {
    this.logRing.push(line);
    if (this.logRing.length > 400) this.logRing.shift();
  }

  async start() {
    const argv = splitCommand(this.command).map((a) =>
      a.replaceAll("{port}", String(this.port))
    );
    if (argv.length === 0) throw new Error("Empty dev command");
    this.state = "starting";
    this.exitInfo = null;
    this.child = spawn(argv[0], argv.slice(1), {
      cwd: this.cwd,
      env: {
        ...process.env,
        ...this.env,               // config `env` — overrides inherited values
        //                            (already stripped of PORT et al. in config)
        PORT: String(this.port),   // sidebranch-owned; always wins over config
        BROWSER: "none",           // stop CRA/next from opening tabs
        FORCE_COLOR: "0",
        SIDEBRANCH: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32", // own process group → clean kill of child trees
      windowsHide: true,
    });
    const forward = (buf) => this.log(buf.toString());
    this.child.stdout.on("data", forward);
    this.child.stderr.on("data", forward);

    // spawn() reports failures (e.g. command not found) via an 'error' event,
    // not 'exit'. ChildProcess is an EventEmitter, so a truly unhandled
    // 'error' event throws and takes down the whole daemon process — every
    // pane, not just this one. Handling it here turns that into an ordinary
    // rejected start() (surfaced to the API caller as a pane error) and
    // aborts the readiness probe immediately instead of waiting out its
    // full timeout.
    const abortReady = new AbortController();
    let startupError = null;
    this.child.on("error", (err) => {
      startupError = err;
      this.exitInfo = { code: null, sig: null };
      this.state = "crashed";
      this.child = null;
      abortReady.abort();
    });
    this.child.on("exit", (code, sig) => {
      this.exitInfo = { code, sig };
      if (this.state !== "stopped") this.state = "crashed";
      this.child = null;
      abortReady.abort();
    });

    try {
      await waitForReady({
        port: this.port,
        path: this.readyPath,
        statuses: this.readyStatuses,
        signal: abortReady.signal,
        paneOrigin: this.paneOrigin,
      });
    } catch (err) {
      if (this.state === "crashed") {
        const reason = startupError
          ? startupError.message
          : `exited during startup${this.exitInfo?.code != null ? ` (exit code ${this.exitInfo.code})` : ""}`;
        const tail = tailText(this.logRing);
        throw new Error(`Dev server ${reason}${tail ? `: ${tail}` : ""}`);
      }
      throw err;
    }
    if (this.state === "crashed") throw new Error("Dev server exited during startup");
    // One extra request, once per server start, on a server we have just
    // proven is answering. Failure here is not a startup failure.
    this.framing = await probeFraming({
      port: this.port,
      path: this.readyPath,
      daemonPort: this.daemonPort,
      paneOrigin: this.paneOrigin,
    });
    this.state = "ready";
    return this;
  }

  async stop() {
    this.state = "stopped";
    const child = this.child;
    if (!child) return;
    await new Promise((resolve) => {
      child.once("exit", resolve);
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch { resolve(); }
      setTimeout(() => {
        try {
          if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch { /* already gone */ }
      }, 5000).unref();
    });
    this.child = null;
  }

  async restart() {
    await this.stop();
    return this.start();
  }
}
