import { test } from "node:test";
import assert from "node:assert/strict";

import { normalize, normalizePaneOrigin, paneUrl } from "../src/config.js";
import { paneFrameSource } from "../src/daemon.js";
import { probeGet } from "../src/processes.js";
import { resolvesToLoopbackOnly } from "../src/security.js";

test("paneOrigin defaults to null and normalizes scheme and hostname", () => {
  assert.equal(normalizePaneOrigin(null), null);
  assert.equal(normalizePaneOrigin(undefined), null);
  assert.deepEqual(normalizePaneOrigin({ hostname: "app.test" }), { scheme: "http", hostname: "app.test" });
  assert.deepEqual(
    normalizePaneOrigin({ scheme: "https", hostname: "  Local.App.TEST  " }),
    { scheme: "https", hostname: "local.app.test" }
  );
});

test("a malformed paneOrigin throws instead of silently falling back to localhost", () => {
  assert.throws(() => normalizePaneOrigin({ scheme: "ftp", hostname: "app.test" }), /scheme/);
  assert.throws(() => normalizePaneOrigin({ scheme: "https" }), /hostname/);
  assert.throws(() => normalizePaneOrigin({ hostname: "" }), /hostname/);
  assert.throws(() => normalizePaneOrigin({ hostname: "not a host" }), /hostname/);
  assert.throws(() => normalizePaneOrigin({ hostname: "-lead.test" }), /hostname/);
  assert.throws(() => normalizePaneOrigin({ hostname: "double..dot" }), /hostname/);
  assert.throws(() => normalizePaneOrigin(["app.test"]), /paneOrigin/);
  assert.throws(() => normalizePaneOrigin("app.test"), /paneOrigin/);
});

test("paneUrl addresses a pane as the browser must reach it", () => {
  assert.equal(paneUrl(null, 4410), "http://localhost:4410/");
  assert.equal(paneUrl({ scheme: "https", hostname: "local.app.test" }, 5173), "https://local.app.test:5173/");
});

test("paneOrigin turns the frame proxy off, and an explicit conflict is refused", () => {
  const cfg = normalize({ dev: "x", paneOrigin: { scheme: "https", hostname: "local.app.test" } });
  assert.equal(cfg.frameProxy, false);
  assert.equal(normalize({ dev: "x" }).frameProxy, true);
  assert.throws(
    () => normalize({ dev: "x", frameProxy: true, paneOrigin: { hostname: "app.test" } }),
    /frameProxy/
  );
});

test("the shell CSP gains the pane origin only when one is configured", () => {
  assert.equal(paneFrameSource(null), "");
  assert.equal(paneFrameSource({ scheme: "https", hostname: "local.app.test" }), " https://local.app.test:*");
});

test("probes speak TLS for an https pane origin and plain http otherwise", () => {
  const plain = probeGet(null, { port: 1, path: "/" }, () => {});
  plain.on("error", () => {});
  assert.equal(plain.agent.protocol, "http:");
  plain.destroy();

  const secure = probeGet({ scheme: "https", hostname: "local.app.test" }, { port: 1, path: "/" }, () => {});
  secure.on("error", () => {});
  assert.equal(secure.agent.protocol, "https:");
  secure.destroy();
});

test("a pane hostname must resolve to loopback", async () => {
  assert.equal(await resolvesToLoopbackOnly("localhost"), true);
  assert.equal(await resolvesToLoopbackOnly("127.0.0.1"), true);
  assert.equal(await resolvesToLoopbackOnly("127.0.0.53"), true);
  assert.equal(await resolvesToLoopbackOnly("sidebranch.invalid"), false);
});
