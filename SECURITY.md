# Security model

sidebranch runs commands (`git`, your dev command, your install command) on
behalf of a browser page. As designed, **nothing ever leaves the local machine and nothing
non-local can ever reach in**.

## Invariants (not configurable)

1. **Loopback bind.** The daemon listens on `127.0.0.1` only. There is no
   flag to bind elsewhere.
2. **Peer verification.** Every request additionally checks the socket's
   remote address is loopback (defense in depth against local forwarders).
3. **Host header allowlist.** Requests whose `Host` is not
   `localhost`/`127.x`/`[::1]` are rejected with 403. This defeats **DNS
   rebinding**, where an attacker's domain resolves to 127.0.0.1 so a remote
   page's requests arrive on a loopback socket — but with the attacker's
   hostname in `Host`.
4. **Origin allowlist.** Browser requests carrying an `Origin` are rejected
   unless that origin is itself a loopback http(s) origin. `Origin: null`
   (sandboxed iframes, `file://`) is rejected. Non-loopback origins never
   receive CORS headers, so even the responses they can't be blocked from
   *requesting* are unreadable to them.
5. **Bearer token on every API call.** A 256-bit token is generated at
   daemon start (rotates each run) and required — with constant-time
   comparison — on all `/api/*` routes, including reads and the event
   stream.
6. **No shell, ever.** All child processes use `execFile`/`spawn` with
   argument arrays. Branch names are validated twice (a conservative
   allowlist regex, then `git check-ref-format --branch`) before reaching
   git; names shaped like options (`-D`), paths (`..`), or containing any
   shell-significant byte are rejected at the API boundary with 400.
7. **No filesystem routing.** The daemon serves three embedded, fixed-path
   assets (`widget.js`, `/shell`, and a bundled font used by both), a
   credential bootstrap (`/handshake`), a liveness probe (`/healthz`), and
   JSON APIs. Every servable path is a hardcoded route, not derived from
   the request URL, so there is no traversal surface no matter how many
   fixed routes that list grows to.
8. **The user's working tree is read-only territory.** The daemon never
   runs a mutating git command outside its own worktrees under
   `~/.sidebranch/`.

## Named pane origins (`paneOrigin`)

A pane's dev server is a command the repo owner already chose to run; it has
never been inside the daemon's trust boundary. `paneOrigin` changes only how
sidebranch *addresses* one — the URL handed to the browser, and the scheme its
own probes speak — for apps whose dev server answers on a name, on TLS, or
both.

None of the eight invariants above move. The daemon still binds `127.0.0.1`,
still checks every peer address, and still rejects any `Host` or `Origin`
that is not loopback. The probes still dial `127.0.0.1`; the configured
hostname only sets SNI. The widget's own gate is unchanged, so it stays inert
on a named origin exactly as it is in production, and such panes are driven
from `/shell`.

Two things constrain what can be configured:

- `sidebranch start` resolves the hostname and **refuses to start unless every
  address it maps to is loopback**. A name that resolves off-box cannot be
  configured at all, so the shell can never be pointed at a remote origin.
- The shell's CSP gains exactly one source, `<scheme>://<hostname>:*`, in
  `frame-src` only. `connect-src` is untouched: the shell still talks to
  nothing but the daemon.

The probe sets `rejectUnauthorized: false`, because a locally-trusted
development certificate is the normal case and Node does not read the system
trust store. This is not a downgrade: the socket destination (`127.0.0.1`, a
port sidebranch itself allocated and spawned a child onto) is what establishes
trust here, not the certificate chain.

## Token delivery

The token reaches a browser two ways, and both are unauthenticated by
necessity — they are what *bootstrap* auth:

1. **Embedded** into `widget.js` and `/shell` at response time, for the
   `<script src>` integration.
2. **Fetched** from `GET /handshake`, for the browser extension. An
   extension cannot use route 1 at all: Manifest V3 forbids executing
   remotely-fetched code, so the extension ships the widget in its own
   package and has nowhere for a substituted token to arrive.

Route 2 discloses nothing route 1 does not. Any caller that clears the gate
below can already read the token out of the `widget.js` response body — the
two routes are the same disclosure to the same audience, differing only in
shape. Both are safe for the same reasons:

(The bundled font both of them load via `@font-face` is unauthenticated for
a different, simpler reason: a browser's font fetch cannot carry a custom
`Authorization` header at all, so gating it by token was never an option.
It carries no secret and no per-run state, so there's nothing at stake in
it being fetchable by anything that already clears the loopback/Host/Origin
gate below.)

- They are only reachable from a loopback socket with a loopback Host
  (invariants 1–3), so only local software can request them at all.
- A **remote** page cannot read them: `fetch()` from a non-loopback origin
  is rejected (invariant 4), and including `<script src="http://localhost:49400/widget.js">`
  executes the code but cannot read its source — the token lives in a
  closure, is never attached to `window`, the DOM, storage, cookies, or
  URLs, and the widget exits before touching the token when the embedding
  page is not loopback.
- Local software on your machine could read them — but local software can
  already run `git` as you directly. sidebranch does not attempt to defend
  you from your own machine; no local tool can.

## "What if the snippet ships to production?"

Designed to be a non-event, twice over:

1. The widget's first statement checks `location.hostname`; on any
   non-loopback page it returns before creating DOM, globals, or network
   traffic. Visitors see nothing and their browser sends nothing.
2. Even a hand-modified copy that skipped that check would be talking to
   the *visitor's* `localhost:49400`. If they don't run sidebranch, the
   request fails. If they do, their daemon rejects the request because the
   page's Origin (your production domain) is not loopback — before any
   token check is even consulted.

There is no third party in the path in any scenario: the script src is
loopback, the API is loopback, and there is no telemetry, no analytics, no
update check, and no outbound network code anywhere in the package.

## Supply chain

Zero runtime dependencies. The daemon, widget, and shell are Node builtins
and vanilla browser APIs only. What you audit in this repo is everything
that runs.

## The shell page

`/shell` is served with a strict CSP (`default-src 'none'` plus loopback
allowances for frames and fetch), `X-Frame-Options: DENY`, `nosniff`, and
`no-referrer`. It embeds only loopback iframes and talks only to the daemon.

## View ports (the compare view's proxy)

When `frameProxy` is on (the default), each pane gets a second loopback port —
a pass-through proxy the compare view frames instead of the pane itself. It
deletes exactly two things from responses: `X-Frame-Options` and the
`frame-ancestors` CSP directive, and declares what it removed in a
`Sidebranch-Removed-Headers` header. Bodies are streamed, never parsed or
rewritten; every other header passes through untouched.

Safeguards, mirroring the daemon's own gate:

- Binds `127.0.0.1` only; non-loopback peers and non-loopback `Host` headers
  are rejected (on websocket upgrades too).
- `Sec-Fetch-Site: cross-site` is rejected, so a remote page cannot frame a
  pane through it — the protection the stripped header was providing.
- The target is fixed at construction to its own pane's port. Nothing in the
  request selects where traffic goes, so it cannot proxy to anything else.
- Dev only, local only, and off with `"frameProxy": false` — the compare view
  then falls back to explaining a refused embed instead of hiding it.

## Residual risks

- **Your dev/install commands are trusted**, exactly like `npm run dev` is:
  checking out and building a branch executes that branch's build tooling.
  Reviewing a malicious PR locally is risky with or without sidebranch;
  panes give you process isolation per branch but not a sandbox. If a PR is
  untrusted, read the diff before you build it — with any tool.
- **`copy` files** (e.g. `.env`) are duplicated into pane worktrees on your
  own disk under `~/.sidebranch/`. Destroying a pane removes its worktree.
- **HTTPS dev servers**: an https page cannot load the http widget (mixed
  content). Run the daemon behind a locally-trusted cert if you need this;
  do not weaken the invariants to work around it.
- **The browser extension**, where used, runs on every page served from
  `localhost`/`127.0.0.1` — that is the scope it requests and the only
  scope it requests. It holds no permission for any other origin, so it
  cannot see, and is never injected into, ordinary browsing. Within that
  scope it does what the script tag does: talk to your daemon, on your
  machine. All of its daemon traffic is issued from the content script, so
  those requests carry the loopback page's own `Origin` and are admitted
  by invariant 4 unchanged — no extension origin is allowlisted, and the
  invariants above are not relaxed for it in any way.

## Reporting

Please report vulnerabilities privately, not as a public issue:

- **Preferred:** [open a private security advisory](https://github.com/cristobalwee/sidebranch/security/advisories/new)
  on the repository.
  If you cannot use GitHub, open an issue asking for a private channel —
  without any details of the vulnerability itself — and one will be
  arranged.

Expect an acknowledgement within a few days. This is a small project
maintained by one person; there is no bounty program, but credit is given
in the changelog for any report that leads to a fix.
