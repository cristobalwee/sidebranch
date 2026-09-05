/**
 * daemon.js — the sidecar HTTP server.
 *
 * Invariants (not configurable):
 *   - Binds 127.0.0.1 only.
 *   - Rejects any request whose peer socket is not loopback.
 *   - Rejects any request whose Host header is not loopback (DNS rebinding).
 *   - Rejects any request whose Origin is present and not loopback.
 *   - Every /api/* request requires the session bearer token.
 *   - Serves only embedded assets; no filesystem paths are derived from URLs.
 *   - /handshake and the three assets are unauthenticated by necessity: they
 *     bootstrap the token. Everything under /api/* requires it.
 *   - Responds with strict security headers; the shell page carries a CSP.
 */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  generateToken, tokenMatches,
  isLoopbackAddress, isAllowedHostHeader, isAllowedOrigin,
  isValidPort,
} from "./security.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dirname, "assets");

/**
 * The /api/* contract version, reported by GET /handshake.
 *
 * The npm package and the browser extension update on different clocks and
 * will drift. Bump this ONLY when a change would break an older widget —
 * adding a field to a response is not a break, changing or removing one is.
 */
export const API_VERSION = 1;

const VERSION = JSON.parse(
  await fs.readFile(new URL("../package.json", import.meta.url), "utf8")
).version;

export class Daemon {
  constructor({ manager, port = 49400 }) {
    this.manager = manager;
    this.port = port;
    // The shell frames panes from this origin, so panes are probed against it.
    this.manager.daemonPort = port;
    this.token = generateToken();
    this.sseClients = new Set();
    this.server = null;

    this.manager.on("event", (ev) => this.broadcast(ev));
  }

  async start() {
    // The widget ships as core + a boot that supplies credentials; the tag
    // channel's boot is the one with placeholders in it. Concatenated here
    // rather than at request time so a malformed asset fails at startup.
    const [core, bootTag] = await Promise.all([
      fs.readFile(path.join(ASSETS, "widget-core.js"), "utf8"),
      fs.readFile(path.join(ASSETS, "boot-tag.js"), "utf8"),
    ]);
    this.widgetSrc = `${core}\n${bootTag}`;
    this.shellSrc = await fs.readFile(path.join(ASSETS, "shell.html"), "utf8");
    this.fontSrc = await fs.readFile(path.join(ASSETS, "geist-pixel.woff2"));

    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) json(res, 500, { error: err.message, code: err.code ?? "EINTERNAL" });
      });
    });
    // Refuse to ever listen on a non-loopback interface.
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, "127.0.0.1", resolve);
    });
    return this;
  }

  async stop() {
    for (const res of this.sseClients) res.end();
    await new Promise((r) => this.server?.close(r));
    await this.manager.shutdown();
  }

  broadcast(ev) {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of this.sseClients) res.write(line);
  }

  /* ------------------------------ gatekeeping ----------------------------- */

  gate(req, res) {
    const peer = req.socket.remoteAddress;
    if (!isLoopbackAddress(peer)) {
      res.writeHead(403).end();
      return false;
    }
    if (!isAllowedHostHeader(req.headers.host)) {
      json(res, 403, { error: "Host not allowed", code: "EHOST" });
      return false;
    }
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin)) {
      json(res, 403, { error: "Origin not allowed", code: "EORIGIN" });
      return false;
    }
    // CORS: only ever reflect loopback origins. Everyone else gets nothing.
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-site");
    return true;
  }

  authed(req) {
    const h = req.headers.authorization || "";
    const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(h);
    return m ? tokenMatches(this.token, m[1]) : false;
  }

  /* -------------------------------- routing ------------------------------- */

  async handle(req, res) {
    if (!this.gate(req, res)) return;
    if (req.method === "OPTIONS") return res.writeHead(204).end();

    const url = new URL(req.url, `http://${req.headers.host}`);
    const route = `${req.method} ${url.pathname}`;

    // -- Assets (no token needed to fetch; tokens are *delivered* by these,
    //    and delivery is safe because the gate above already guarantees a
    //    loopback peer, loopback Host, and loopback-or-absent Origin). A
    //    cross-origin remote page cannot read these responses: fetch() is
    //    blocked by CORS above, and <script src> keeps the token inside the
    //    widget's closure where the embedding page cannot reach it.
    if (route === "GET /widget.js") return this.serveWidget(res);
    if (route === "GET /shell") return this.serveShell(res);
    // Unauthenticated for the same reason as the two above, plus a harder
    // constraint: a browser's @font-face fetch can't carry an Authorization
    // header at all, so this could never be gated by the bearer token even
    // if we wanted it to be. Unlike widget.js/shell (no-store — they embed a
    // token that rotates every run), this file never changes for a given
    // version of the tool, so it's cached aggressively.
    if (route === "GET /geist-pixel.woff2") return this.serveFont(res);
    if (route === "GET /handshake") return this.serveHandshake(res);
    if (route === "GET /healthz") return json(res, 200, { ok: true });

    if (!url.pathname.startsWith("/api/")) return json(res, 404, { error: "Not found" });
    if (!this.authed(req)) return json(res, 401, { error: "Missing or invalid token", code: "EAUTH" });

    if (route === "GET /api/state") return json(res, 200, await this.manager.state());
    if (route === "GET /api/events") return this.serveEvents(req, res);
    const logMatch = req.method === "GET" && /^\/api\/pane\/([^/]+)\/log$/.exec(url.pathname);
    if (logMatch) {
      const info = this.manager.getPaneLog(logMatch[1]);
      if (!info) return json(res, 404, { error: "Unknown pane", code: "EBADPANE" });
      return json(res, 200, info);
    }
    if (route === "POST /api/fetch") {
      await this.manager.fetch();
      return json(res, 200, { ok: true });
    }
    if (route === "POST /api/pane") {
      const body = await readJson(req);
      const { pane, branch, discard } = body ?? {};
      try {
        const info = await this.manager.ensurePane(String(pane), String(branch), { discard: discard === true });
        return json(res, 200, info);
      } catch (err) {
        const status = err.code === "EBADREF" || err.code === "EBADPANE" ? 400
          : err.code === "EDIRTY" || err.code === "EBUSYTREE" ? 409 : 500;
        return json(res, status, { error: err.message, code: err.code ?? "EINTERNAL" });
      }
    }
    if (route === "POST /api/pane/stop") {
      const { pane } = (await readJson(req)) ?? {};
      await this.manager.stopPane(String(pane));
      return json(res, 200, { ok: true });
    }
    if (route === "POST /api/pane/destroy") {
      const { pane } = (await readJson(req)) ?? {};
      await this.manager.destroyPane(String(pane));
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "Not found" });
  }

  serveWidget(res) {
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (!this.manager.config.widget) {
      return res.end("/* sidebranch widget disabled via .sidebranch.json */\n");
    }
    const src = this.widgetSrc
      .replaceAll("__SIDEBRANCH_TOKEN__", this.token)
      .replaceAll("__SIDEBRANCH_PORT__", String(this.port));
    res.end(src);
  }

  /**
   * Credential bootstrap for callers that cannot consume a rendered template
   * — i.e. the browser extension, whose content script ships `widget-core.js`
   * in its own package because Manifest V3 forbids executing remotely-fetched
   * code, and so has nowhere for a substituted token to arrive.
   *
   * This discloses nothing that `GET /widget.js` does not already disclose:
   * any caller that clears the gate above can read the token straight out of
   * the widget response body today. SECURITY.md's "token delivery is
   * unauthenticated by necessity" covers both; this is the same disclosure
   * with an honest shape instead of a string-substituted one.
   *
   * Deliberately NOT under /api/*, because the bearer check there is exactly
   * what this endpoint exists to bootstrap.
   */
  serveHandshake(res) {
    res.setHeader("Cache-Control", "no-store");
    json(res, 200, {
      token: this.token,
      port: this.port,
      // Honors `"widget": false` in .sidebranch.json, which the tag channel
      // honors by serving a no-op body. The extension has to be told.
      widget: this.manager.config.widget === true,
      version: VERSION,
      // Bumped only on a breaking change to the shapes below /api/*. The
      // extension refuses to render on a mismatch rather than half-working
      // against a daemon it doesn't understand.
      apiVersion: API_VERSION,
    });
  }

  serveShell(res) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    // The shell embeds iframes of pane dev servers (loopback http origins)
    // and talks only to this daemon. CSP pins both facts.
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'none'",
        "script-src 'unsafe-inline'",
        "style-src 'unsafe-inline'",
        "connect-src http://localhost:* http://127.0.0.1:*",
        `frame-src http://localhost:* http://127.0.0.1:*${paneFrameSource(this.manager.config.paneOrigin)}`,
        "font-src http://localhost:* http://127.0.0.1:*",
        "img-src data:",
        "base-uri 'none'",
        "form-action 'none'",
      ].join("; ")
    );
    res.setHeader("X-Frame-Options", "DENY");
    const src = this.shellSrc
      .replaceAll("__SIDEBRANCH_TOKEN__", this.token)
      .replaceAll("__SIDEBRANCH_PORT__", String(this.port));
    res.end(src);
  }

  serveFont(res) {
    res.setHeader("Content-Type", "font/woff2");
    // No token, no per-run state in this file — safe to cache hard, unlike
    // widget.js/shell above.
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.end(this.fontSrc);
  }

  serveEvents(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "hello", at: Date.now() })}\n\n`);
    this.sseClients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(ping);
      this.sseClients.delete(res);
    });
  }
}

/* --------------------------------- helpers -------------------------------- */

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("Body too large"), { code: "EBODY" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(Object.assign(new Error("Invalid JSON body"), { code: "EBODY" })); }
    });
    req.on("error", reject);
  });
}

export function paneFrameSource(paneOrigin) {
  if (!paneOrigin) return "";
  return ` ${paneOrigin.scheme}://${paneOrigin.hostname}:*`;
}

export { isValidPort };
