<img width="1730" height="454" alt="Frame@2x (1)" src="https://github.com/user-attachments/assets/da10cd7e-2db2-4efe-bbe2-77cbb0793bcb" />

---

Review pull requests from inside your running app. sidebranch is a local
sidecar daemon plus a small in-page widget: pick a branch from a floating
control and it appears in a dedicated **review worktree** on its own dev
server. Your working tree, uncommitted changes and all, is never touched.
Open a PR branch next to `main` in a synced side-by-side view, or stack them
with a blend/layer diff to spot visual regressions.

- **Framework-agnostic.** Next on 3000, Vite on 5173, Django on 8080 — if it
  starts from a command and answers HTTP on a port, it works.
- **Nothing leaves your machine.** The daemon binds loopback only, every
  request is authenticated, and the widget is inert outside a localhost page.
  Zero runtime dependencies — Node builtins only.
- **Unobtrusive.** One small pill in the corner, rendered only when the daemon
  is running. `×` hides it for the session, Esc closes the panel, and
  `"widget": false` turns it off entirely.

## How it works

```
your app (:5173, your working tree — never touched)
   └── the widget — browser extension, or a <script> tag you add
sidebranch daemon (127.0.0.1:49400)
   ├── pane A → worktree ~/.sidebranch/…/panes/a → dev server :4410
   ├── pane B → worktree ~/.sidebranch/…/panes/b → dev server :4411
   └── /shell → compare view (side-by-side / blend / layer)
```

Panes are persistent review environments built on `git worktree`. Switching a
pane to another branch is a checkout inside that pane. Dependencies are
re-installed only when a lockfile actually changed (by content hash), and the
dev server restarts only in that case; otherwise its file watcher picks up the
checkout like any other change. Panes are never edited by hand, so they are
always clean — nothing to stash, nothing to lose.

## Quick start

**1. Install the browser extension** —
**[sidebranch on the Chrome Web Store](https://chromewebstore.google.com/detail/sidebranch/ljgndbomggclpkejggdhocihphhhdhig)**
(Chrome or Edge). Install it once and every project you run the daemon in gets
the pill, with no change to any app's HTML.

**2. Start the daemon in your repo:**

```sh
cd your-repo
npx sidebranch init      # writes .sidebranch.json — edit for your stack
npx sidebranch start     # daemon on http://127.0.0.1:49400
```

**3. Open your dev server** on `http://localhost:…` and the pill appears
bottom-right. Click it → pick a branch → it builds and serves in pane A.
**Open A** views it; **Compare A/B** opens the split view.

The extension requests two origins — `http://localhost/*` and
`http://127.0.0.1/*` — and one permission, `storage`, for a port override on
its options page (set that if you run `start --port`). It talks to nothing but
your own daemon, renders nothing if none is running, and is never injected
into ordinary browsing.

Source lives in [`extension/`](extension/) if you'd rather load it unpacked —
`chrome://extensions` → Developer mode → **Load unpacked** → select
`extension/`. See [`extension/README.md`](extension/README.md) for details.

### Or inject it yourself: the script tag

The daemon also serves the widget as a plain script, which is what you want if
you're on a browser the extension doesn't cover (Firefox, Safari), your dev
server is on `http://[::1]:5173`, or you'd rather not install an extension at
all. Add it to your app, **dev builds only**:

```html
<script src="http://localhost:49400/widget.js" defer></script>
```

Gate it however your stack gates dev-only code, e.g.:

```jsx
// Next.js (app/layout.tsx)
{process.env.NODE_ENV === "development" && (
  <script src="http://localhost:49400/widget.js" defer />
)}
```

```html
<!-- Vite (index.html) -->
<script>
  if (import.meta.env.DEV) {
    const s = document.createElement("script");
    s.src = "http://localhost:49400/widget.js"; s.defer = true;
    document.head.appendChild(s);
  }
</script>
```

If the tag does ship to production, it's harmless: the widget refuses to run
on non-localhost pages, and a visitor's own daemon — if they run one — rejects
requests from non-loopback origins. See [SECURITY.md](SECURITY.md).

Everything else is identical, including the compare view. Two differences from
the extension:

- **A strict `Content-Security-Policy` can block the script tag.** It can't
  block the extension, whose content script isn't subject to the page's CSP.
  (The widget's font is bundled and loaded as binary so a strict `font-src`
  can't downgrade it either.)
- **A page served from `http://[::1]:5173` gets the widget from the tag but
  not from the extension** — Chrome match patterns can't express an IPv6
  literal. `http://localhost` reaches the same server, if you'd rather use
  the extension.

With the tag, clearing **Hide for this session** means opening a new tab; the
toolbar button that undoes it is the extension's.

## Configuration (`.sidebranch.json`)

```jsonc
{
  "dev": "npm run dev",                 // start command, run inside each pane
                                        //   {port} is substituted; PORT env is always set
  "install": "pnpm install",            // run only when lockfiles change; "" disables
  "ready": { "path": "/", "statuses": null },  // readiness probe; null = any HTTP answer
  "panes": 2,                           // review environments kept warm (1–4)
  "basePort": 4410,                     // first port tried for pane servers
  "copy": [".env", ".env.local"],       // untracked files copied into new worktrees
  "env": {},                            // extra env vars for the pane dev command
                                        //   overrides inherited values; PORT etc. are reserved
  "lockfiles": ["package-lock.json"],   // override the manifest list if needed
  "widget": true,                       // false → /widget.js serves a no-op
  "frameProxy": true,                   // false → compare view frames panes directly
  "paneOrigin": null                    // { scheme, hostname } a pane answers on;
                                        //   null = http://localhost
}
```

### `paneOrigin` — panes that only answer on a name, or on TLS

By default sidebranch addresses a pane as `http://localhost:<port>`. Some dev
servers can't be reached that way: an app whose auth or API is pinned to a
domain (cookies scoped to it, an origin allowlist upstream) has to be loaded
from that name, and one that binds TLS won't answer plain http at all. The
readiness probe times out and the compare view frames nothing.

`paneOrigin` tells sidebranch how a pane is addressed:

```jsonc
"paneOrigin": { "scheme": "https", "hostname": "local.app.test" }
```

The hostname must already resolve to a loopback address — a `/etc/hosts` entry
pointing at `127.0.0.1` — and `sidebranch start` refuses to run if it doesn't.
Sidebranch still dials `127.0.0.1` for its probes and still binds loopback
only; the hostname sets SNI and the URL the browser is handed. A self-signed
or locally-trusted certificate is fine, because the probe is not what
establishes trust — the socket destination is.

Two consequences worth knowing:

- **View ports turn off.** They serve on `localhost` and so cannot preserve a
  custom origin; framing a pane through one would defeat the point. Setting
  `"frameProxy": true` alongside `paneOrigin` is a config error rather than a
  silent override.
- **The widget stays loopback-only.** It self-disables unless the *page* it
  runs on is loopback — that's what makes a production-shipped `<script>` tag
  inert — so a pane on a named origin is driven from `/shell`, not the pill.

Recipes:

| Stack | `dev` | `install` |
| --- | --- | --- |
| Next.js | `npm run dev` | `npm install` |
| Vite | `npx vite --port {port}` | `pnpm install` |
| Django | `python3 manage.py runserver 127.0.0.1:{port}` | `pip install -r requirements.txt` |
| Rails | `bin/rails server -p {port}` | `bundle install` |
| Static | `python3 -m http.server {port} --bind 127.0.0.1` | *(empty)* |

The daemon never parses server output. A pane is "ready" when its port answers
the probe, which also catches servers that silently pick a different port than
asked.

## Complex apps: multiple processes, databases, and credentials

sidebranch runs one process per pane and injects one port. Real apps often
need more — a database or emulator, an auth proxy, a background worker,
credentials for cloud services. That takes one architectural idea plus two
config levers.

### The one rule: per-pane process, shared singletons

Your `dev` command is the only thing sidebranch runs per pane, and it can only
vary one port. So anything that is a **singleton** — a database, an emulator
on a fixed port, an auth proxy — must run once, outside sidebranch, shared by
every pane and your own dev session. Keep the per-pane command down to the
single server that renders the branch.

If your normal dev command is a bundle like `concurrently "db" "web" "proxy"`,
don't point sidebranch at it — two panes would each try to start the db and
proxy on the same fixed ports and collide. Instead:

- point `dev` at just the web server (`"dev": "npm run dev:web"`),
- run the db/emulator/proxy once yourself, and
- tell each pane how to reach them with `env`.

### Two levers for everything a pane needs

| Need | Lever | How |
| --- | --- | --- |
| An untracked **file** the app reads (`.env`, a service-account key, a cert) | `copy` | Copied from your main tree into each pane once, at creation. |
| An **environment variable** (point at a shared service, flip a mode, unset a stale path) | `env` | Injected into the pane's dev command; overrides inherited values. |
| A credential in a **machine-wide, out-of-tree location** (`~/.config/gcloud`, `~/.aws`, `~/.netrc`) | *(nothing)* | Panes run as you, so home-dir credentials resolve for free. |

The third row is the one people miss: only in-repo, relative-path credentials
break in a pane, because they resolve against the pane's own directory.
Home-directory credentials need no `copy` and no `env`.

### `env`: precedence and the empty-string unset

`env` values layer on top of the inherited environment, so they override what
your shell exported and what a copied `.env` would set. The exception is the
vars sidebranch owns — `PORT`, `BROWSER`, `FORCE_COLOR`, `SIDEBRANCH` —
because overriding `PORT` would break port injection. Those are dropped from
`env` if you set them.

Setting a var to the **empty string** unsets an inherited value:

```jsonc
"env": { "GOOGLE_APPLICATION_CREDENTIALS": "" }
```

That's the fix when a copied `.env` points a credential at an in-repo relative
path: blank it in the pane and let the SDK fall back to your machine's default
credentials.

### Worked example: web app + database emulator + cloud credentials

An app whose `npm run dev` starts an emulator, the web server, and a cloud
auth proxy, and whose `.env` sets a relative-path service-account key:

1. Keep the emulator running once (your normal dev session already starts it).
2. Point the pane at just the web server, tell it to use the shared emulator,
   and blank the in-repo key so cloud SDKs fall back to machine ADC:

```jsonc
{
  "dev": "npm run dev:web",            // web server only — NOT the bundle
  "install": "npm install",
  "copy": [".env", ".env.local"],      // carry app config/secrets, but not the key file
  "env": {
    "FIRESTORE_EMULATOR_HOST": "127.0.0.1:8080",   // reach the shared emulator
    "GOOGLE_APPLICATION_CREDENTIALS": ""           // fall back to ~/.config/gcloud ADC
  }
}
```

No credential file is copied into any pane, every pane points at the one
shared emulator, and other cloud calls authenticate via machine-wide ADC.
(Prerequisite: you've run your cloud CLI's "application default login" — the
same setup your app already needs locally.)

### Checklist for porting sidebranch into an app

1. **What does your dev command start?** If it's more than one server, split
   off the singletons.
2. **Run the singletons once** (or confirm your normal dev session does).
3. **Point `dev` at the single per-pane server**; make sure it honors `PORT`
   (or use `{port}`).
4. **`copy` the untracked files** the app needs — except secrets you can reach
   another way.
5. **For each service the app talks to**, choose: shared instance (`env` points
   at it), machine-wide credential (free), or copied file (`copy`).
6. **Blank any in-repo relative credential paths** with `"env": { "VAR": "" }`.
7. **`npx sidebranch doctor`**, then `start`, then open a pane.

### Prompt your coding agent to do it

Paste this into Claude Code / Cursor / your agent of choice, from your repo
root — it produces a `.sidebranch.json` tailored to your stack:

```text
Integrate sidebranch (a local PR-review sidecar) into this app. Steps:
1. Read package.json (or the equivalent) and identify the dev command(s).
   List every process and fixed port the normal dev workflow starts —
   web server, database/emulator, proxies, workers.
2. Identify which of those are singletons (fixed ports, shared state) vs the
   single web server that actually renders the app.
3. Find every credential/secret the app loads locally and where it comes
   from: in-repo relative-path files, machine-wide locations (~/.config,
   ~/.aws), or environment variables.
4. Write a .sidebranch.json where:
   - "dev" runs ONLY the web server, honoring the PORT env var (or {port}),
   - "copy" lists the untracked files the app needs at runtime,
   - "env" points the pane at the shared singletons and blanks ("") any
     in-repo relative credential paths so SDKs fall back to machine defaults.
5. Only if I tell you I am NOT using the browser extension, add the widget
   to the app's HTML/layout, gated to development only:
   <script src="http://localhost:49400/widget.js" defer></script>
6. Tell me exactly which singleton processes I must run once myself before
   using panes, and any one-time credential setup (e.g. cloud ADC login).
Do not modify my existing dev scripts or app code beyond that widget tag.
```

## Compare view

`http://localhost:49400/shell` (or the **Compare A/B** button):

- **Side by side** — both panes live, one width control driving both viewports
  in lockstep (slider + 375/768/1280 presets).
- **Blend diff** — panes stacked with `mix-blend-mode: difference`; identical
  pixels go black, any change glows.
- **Layer diff** — stacked with an opacity slider on the top pane.
- **⇄ Swap** exchanges the panes' branches.

Scroll and interaction sync between frames is out of scope: the stacked modes
answer "did anything move?" and side-by-side answers "how does it behave?",
without proxying or injecting script into your app.

### Apps that refuse to be framed

Panes and the compare view run on different ports, so they're different
origins — an app sending `X-Frame-Options: SAMEORIGIN` or a restrictive
`frame-ancestors` would render as a blank frame.

So the compare view doesn't frame panes directly. Each pane gets a **view
port**: a local pass-through proxy that deletes those two framing headers and
nothing else, and names what it removed in a `Sidebranch-Removed-Headers`
response header. Your app's code, its other headers, and the direct pane port
(used by **Open in new tab**) are untouched, and your production config is
never involved. Set `"frameProxy": false` to turn this off; a refusing app
then gets an explanation in the pane instead of an embed. Details and
safeguards: [SECURITY.md](SECURITY.md).

## Non-goals and guarantees

- sidebranch never runs a mutating git command against your primary working
  tree. No stash, no reset, no checkout — reads only.
- A dirty *pane* (someone edited a review worktree by hand) fails safe: the
  switch is refused until you opt into discarding, and only files inside that
  pane are affected.
- Worktrees live under `~/.sidebranch/`, outside your repo, so file watchers
  and tooling in your main tree never see them.

## Stopping and cleanup

`sidebranch stop` shuts down the daemon and its pane dev servers from any
terminal, so you don't have to find the tab it's running in:

```sh
sidebranch stop
```

Pane worktrees survive a stop, so the next `start` reuses them instead of
re-installing everything. That means a pane still holds the branch it last
checked out, and git refuses to check out a branch already checked out
elsewhere:

```
fatal: 'main' is already used by worktree at '/Users/you/.sidebranch/projects/.../panes/a'
```

`sidebranch clean` removes those worktrees:

```sh
sidebranch clean           # lists panes, asks to confirm, then removes them
sidebranch clean --pane a  # target a single pane
sidebranch clean --yes     # skip the confirmation prompt (for scripts/agents)
```

`clean` refuses to run while a daemon is serving this repo, since removing a
worktree out from under a running dev server would leave it serving a
directory that no longer exists. Run `stop` first; `clean` will say so if you
haven't.

Both commands work from a record the daemon writes to
`~/.sidebranch/projects/<repo>/daemon.json`. If a daemon is killed outright
(`kill -9`, a closed terminal), that record is left behind, and the next
`stop`, `start`, or `doctor` clears it. Neither command signals a process it
hasn't confirmed is a sidebranch daemon, so a stale record whose pid the OS
has recycled is harmless.

## Commands

```
sidebranch init      write starter config
sidebranch start     run the daemon (--port N, default 49400)
sidebranch stop      stop the daemon serving this repo
sidebranch clean     remove stale pane worktrees for this repo (--pane, --yes)
sidebranch doctor    environment checks (including daemon status)
```

## Development

```sh
node --test test/*.test.js
```

The suite covers the security gauntlet (token, Host/Origin gating, hostile ref
names), the full worktree lifecycle against real fixture repos, and an
end-to-end run that boots two panes on two branches and asserts both serve.

## License

MIT — see [LICENSE](LICENSE).

One exception: the bundled UI font (`src/assets/geist-pixel.woff2`) is a
modified build of [Geist Pixel](https://github.com/vercel/geist-font) under
the SIL Open Font License 1.1, not MIT. Its license, copyright notices, and
the modifications made are recorded in
[`src/assets/geist-pixel.LICENSE.txt`](src/assets/geist-pixel.LICENSE.txt).
