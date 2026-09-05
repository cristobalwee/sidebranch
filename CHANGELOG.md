# Changelog

Notable changes to sidebranch. This project follows
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`paneOrigin` config** — address panes on a hostname, over TLS, or both, for
  dev servers that don't answer as `http://localhost:<port>` (auth or cookies
  pinned to a domain, a server that binds TLS). Sidebranch still binds and
  probes loopback; the hostname sets SNI and the URL the browser is given, and
  `start` refuses a hostname that resolves anywhere but loopback. View ports
  turn off with it, since they serve on `localhost` and cannot preserve a
  custom origin. No security invariant changes — see `SECURITY.md`.

- **Browser extension** (`extension/`) — a second delivery channel for the
  widget: install once and every project you run `sidebranch start` in gets
  the pill, with no `<script>` tag in your app. MV3, published on the
  [Chrome Web Store](https://chromewebstore.google.com/detail/sidebranch/ljgndbomggclpkejggdhocihphhhdhig)
  and also loadable unpacked from `extension/`; not part of the npm package. Permissions are `storage` (a port override) plus
  `http://localhost/*` and `http://127.0.0.1/*`. It has no service worker, so
  all daemon traffic goes through the content script and every invariant in
  `SECURITY.md` still holds. Unlike the tag, it can't be blocked by a page's
  CSP — and can't reach a page served from `http://[::1]`.
- **Extension toolbar popup** — undoes "Hide for this session", which is per
  tab and previously needed a new tab to clear.
- **View ports** — each pane gets a local pass-through proxy that deletes
  `X-Frame-Options` and CSP `frame-ancestors`, so the compare view works with
  apps that refuse framing. Removals are named in a `Sidebranch-Removed-Headers`
  response header, bodies stream through byte-identical, and the proxy carries
  the daemon's loopback/Host gate (upgrades included). Set `"frameProxy": false`
  to disable. Direct pane ports are untouched.
- **Frame-refusal detection** — the daemon probes for framing headers once per
  server start, and the shell names the header and the fix instead of rendering
  a blank rectangle.
- **Info flyout** in the widget toolbar (ⓘ): start and stop commands with this
  daemon's port substituted, click-to-copy, and which delivery channel you're
  looking at.
- `sidebranch stop` — shuts down the daemon and its pane dev servers from any
  terminal. Backed by a per-repo `daemon.json` record, which also lets `start`
  refuse to launch over an existing daemon, lets `clean` refuse to delete
  worktrees out from under a running dev server, and lets `doctor` report
  daemon status. Stale records are detected and cleared; no command signals a
  process it hasn't confirmed is a sidebranch daemon.
- `GET /handshake` — unauthenticated credential bootstrap returning
  `{token, port, widget, version, apiVersion}` for the extension, behind the
  same loopback/Host/Origin gate as every other route. Discloses nothing that
  `GET /widget.js` did not.
- `fontSource` option in `widget-core.js`, so a caller can pass the font as
  binary instead of a URL. The extension uses it because a `FontFace` built
  from a URL is subject to the page's `font-src` CSP.
- `src/assets/geist-pixel.LICENSE.txt` — the bundled font is SIL OFL 1.1, not
  MIT, and previously shipped without its license text.
- A landing page under `site/`, deployed to GitHub Pages. Not part of the npm
  package and adds no dependencies.
- CI: the suite runs on Node 20/22/24 across Linux and macOS and asserts the
  dependency count is still zero.
- `prepublishOnly` runs the suite, so a red build can't reach the registry.
- Releases publish from a tagged workflow with npm provenance.

### Changed

- The bundled UI font is now `geist-pixel.woff2` (24 KB) instead of
  `geist-pixel.ttf` (3.7 MB). All 481 glyphs are retained and nothing renders
  differently; the package drops from 3.8 MB unpacked to ~150 KB.
- `src/assets/widget.js` split into `widget-core.js` (the UI) and `boot-tag.js`
  (the tag channel's credential delivery). No user-visible change —
  `GET /widget.js` serves the same assembled script. This is what lets the
  extension ship the identical widget without shipping a secret.
- `SECURITY.md` names a concrete reporting route.

### Fixed

- A worktree deleted from disk but still registered in git no longer wedges its
  pane with a misleading `spawn git ENOENT`. `ensurePane` prunes the stale
  registration and recreates the worktree; `doctor` reports the state. Also
  fixes worktree path matching for deleted directories on macOS tmp paths
  (the `/var` → `/private/var` symlink).
- Piping CLI output (`sidebranch stop | head -1`) no longer crashes with EPIPE
  when the pipe closes early.
- The extension no longer injects the widget into the daemon's own `/shell`
  page, which matched the content script like any other localhost dev server.
- CI runs on Node 20 again. `node --test "test/*.test.js"` relies on glob
  expansion Node only gained in v21, so both Node 20 jobs had been failing
  without running a test. The glob is now unquoted and expanded by the shell.

## [0.1.0]

Initial release: loopback-only PR review sidecar with worktree panes, an
in-page widget, and the side-by-side / blend / layer compare shell.
