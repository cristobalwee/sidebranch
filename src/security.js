/**
 * security.js — the trust boundary of sidebranch.
 *
 * Threat model (see SECURITY.md for the full write-up):
 *   1. A malicious *remote* website loaded in the user's browser tries to
 *      reach the daemon (CSRF-style requests to http://localhost:49400,
 *      or DNS-rebinding where evil.com resolves to 127.0.0.1).
 *   2. The widget <script> tag accidentally ships to production, where it
 *      runs on end users' machines pointed at *their* localhost.
 *   3. Command injection through branch names or config values.
 *   4. A non-loopback network peer connecting to the daemon.
 *
 * Defenses, layered (each is sufficient on its own for its attack):
 *   - The daemon binds 127.0.0.1 only, and additionally verifies the peer
 *     socket address of every request (defense in depth vs. proxies).
 *   - Every request's Host header must be a loopback host. This defeats
 *     DNS rebinding, where the socket is loopback but Host is attacker-owned.
 *   - Every state-changing or state-revealing API call requires a bearer
 *     token that is only ever embedded in assets served to loopback pages.
 *   - CORS is only granted to loopback origins; all other origins get no
 *     CORS headers at all, so their reads fail in the browser.
 *   - The widget self-disables unless the *page* it runs on is loopback,
 *     so a production deployment of the snippet is inert by construction.
 *   - All git/process invocations use execFile/spawn with argument arrays
 *     (never a shell), and ref names are validated before use.
 */

import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** True if an IP address literal is a loopback address. */
export function isLoopbackAddress(addr) {
  if (!addr) return false;
  // Node reports IPv4-mapped IPv6 like ::ffff:127.0.0.1
  const v4 = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  if (net.isIPv4(v4)) return v4.startsWith("127.");
  if (net.isIPv6(addr)) return addr === "::1";
  return false;
}

/** True if a URL hostname (no port) refers to loopback. */
export function isLoopbackHostname(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(h)) return true;
  if (net.isIPv4(h)) return h.startsWith("127.");
  return false;
}

export async function resolvesToLoopbackOnly(hostname) {
  if (isLoopbackHostname(hostname)) return true;
  let records;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    return false;
  }
  return records.length > 0 && records.every((r) => isLoopbackAddress(r.address));
}

/**
 * Validate a Host header value ("localhost:49400", "127.0.0.1:49400").
 * Rejects anything that is not an explicit loopback host — this is the
 * DNS-rebinding defense and must never be relaxed.
 */
export function isAllowedHostHeader(hostHeader) {
  if (!hostHeader) return false;
  try {
    // URL parsing handles [::1]:49400 bracket syntax for us.
    const { hostname } = new URL(`http://${hostHeader}`);
    return isLoopbackHostname(hostname);
  } catch {
    return false;
  }
}

/**
 * Validate an Origin header. Only http(s) pages served from loopback may
 * talk to the daemon. Requests with no Origin (curl, same-origin GETs)
 * are allowed at this layer; the token layer still gates everything.
 */
export function isAllowedOrigin(origin) {
  if (origin === undefined || origin === null || origin === "") return true;
  if (origin === "null") return false; // sandboxed iframes / file:// pages
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return isLoopbackHostname(u.hostname);
  } catch {
    return false;
  }
}

/** Generate a session token. Rotates on every daemon start. */
export function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

/** Constant-time token comparison. */
export function tokenMatches(expected, presented) {
  if (typeof presented !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Conservative branch/ref name validation, applied *in addition to*
 * `git check-ref-format` (see gitops.js). Belt and suspenders: even if a
 * name passes git's rules, we refuse anything that could read as an
 * option (leading "-"), contain shell-significant bytes, or traverse paths.
 */
const REF_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
export function isSafeRefName(name) {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > 250) return false;
  if (name.startsWith("-")) return false;
  if (name.includes("..") || name.includes("@{")) return false;
  if (/[\s~^:?*\[\\\x00-\x1f\x7f'"`$;&|<>(){}!#%]/.test(name)) return false;
  return name.split("/").every((seg) => seg.length > 0 && REF_SEGMENT.test(seg));
}

/** Validate a slug used for worktree directory names. */
export function isSafeSlug(s) {
  return typeof s === "string" && /^[a-z0-9][a-z0-9-]{0,80}$/.test(s);
}

/** Validate a TCP port number from untrusted input. */
export function isValidPort(p) {
  return Number.isInteger(p) && p >= 1 && p <= 65535;
}
