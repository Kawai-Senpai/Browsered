<div align="center">

<img src="brand/banner.svg" alt="browserd — record first, query later" width="100%">

<br>

**Not "Playwright driven by an LLM" — a browser daemon that records everything it sees,
so your agent can ask about traffic that happened before you thought to ask.**

<br>

[![tools](https://img.shields.io/badge/tools-192-26C08A?style=flat-square&labelColor=16181C)](#the-tool-surface)
[![tests](https://img.shields.io/badge/live%20tests-164%20passing-26C08A?style=flat-square&labelColor=16181C)](#testing)
[![protocol](https://img.shields.io/badge/MCP-1.30-8A9199?style=flat-square&labelColor=16181C)](https://modelcontextprotocol.io)
[![runtime](https://img.shields.io/badge/node-%E2%89%A520.11-8A9199?style=flat-square&labelColor=16181C)](https://nodejs.org)
[![data](https://img.shields.io/badge/data-local%20only-D99A2B?style=flat-square&labelColor=16181C)](#security-notes)
[![license](https://img.shields.io/badge/license-MIT-8A9199?style=flat-square&labelColor=16181C)](LICENSE)

</div>

---

## What this actually is

Most browser-MCP servers wrap Playwright and let a model click things. That is a small
fraction of what a developer does with a browser open.

`browserd` runs a **real, headed Chromium you can use yourself** while an agent watches
over its shoulder. It holds a persistent CDP connection, records network, console,
exceptions and navigations **continuously**, and stores them in SQLite. When the model
finally asks a question, it queries a database — not the browser.

<div align="center">
  <img src="brand/flow.svg" alt="Chromium pushes CDP events into always-on recorders that persist to SQLite and blobs; the agent queries that store over MCP rather than asking the browser." width="100%">
</div>

The difference matters. Ask a normal browser-automation MCP "why did checkout fail?"
and it has nothing — the request is gone. Ask `browserd` and it has the payload, the
response body, the console error, the stack trace, and the exact source line.

---

## What your agent can do

| | |
|---|---|
| **See** | Screenshots (viewport / full-page / element) returned as real image blocks. Accessibility snapshots with stable `eNN` refs — cheaper and more reliable than vision for deciding what to click. |
| **Act** | Click, hover, type, key chords, scroll, select, upload, handle dialogs. Falls back to touch dispatch under device emulation. |
| **Network** | Every request with **all** headers (including what actually went on the wire), request payloads, response bodies, initiators, timings, redirect chains, WebSocket frames. Recording is armed before the first page script runs. |
| **Console** | `console.*` output and uncaught exceptions with stacks, **kept across navigations**. Plus `Runtime.evaluate` with the DevTools command-line API (`$`, `$$`, `$x`). |
| **DOM / CSS** | Structural outlines, the full cascade as DevTools shows it, and `css.explain_visibility` — which names the rule that hid your element instead of handing over a stylesheet. |
| **Debugger** | Real breakpoints with conditions, stepping, call frames, scope chains, evaluate-on-frame. Read a local variable off a paused stack. |
| **Storage** | localStorage, sessionStorage, cookies, IndexedDB (read *and* write), Cache Storage, quotas. |
| **Profiling** | CPU sampling, JS coverage, traces streamed to disk, heap snapshots with **constructor-level diffing** for leak hunting, process/CPU info. |
| **Simulation** | A controlled clock, timezone, CPU throttling, network conditions, device emulation, geolocation, vision deficiencies, and fault injection. |
| **Repeat** | Restore a session from an export instead of replaying its login, and save parameterised workflows that replay a real sequence with different values, each step asserting it landed. |
| **Hidden errors** | `app.error_state` reads the errors your app is *holding* — the ones TanStack Query, SWR or Redux caught and stored as state, where `console.exceptions` structurally cannot see them. An empty console is not evidence that nothing threw. |
| **Dead controls** | `app.diagnose_interaction` clicks a control and reports what the application did about it: handler attached, handler threw, request initiated, input consumed, guard returned early. `page.click` tells you the DOM moved; unrelated re-renders make that true for a click that did nothing. |
| **Self-documenting** | `guide.orient` is the one-call orientation: every family, what each is for, which tool fits which situation. `guide.search` finds the right tool from a plain description of the problem; `guide.tool` gives the long write-up with caveats; `guide.topic` covers the architecture, the traps, and where this daemon is installed. |
| **Skeletons** | `skeleton.capture` measures the real UI at several widths and emits a pixel-accurate loading placeholder as HTML, CSS or a React/Vue/Svelte component. |
| **Test handoff** | `locator.candidates` names an element the way a durable test must — role, label, text or test id — and counts what each one actually matches. `qa.*` records a driven flow as scenario steps and hands the evidence to a test harness. |
| **Handover** | `browser.reveal` puts a headless session on screen for the human in one call, and control modes arbitrate who drives. |

### The bits people don't expect

**Time travel.** `time.run("30m")` advances the clock and fires every timer that comes
due — a 60-second interval fires 30 times, instantly. `time.jump("30m")` leaps forward
firing each timer *once*, the "closed the laptop for three hours" case. Different bug
classes, different tools.

```
time.install({ time: "2030-01-01T00:00:00Z" })   # page now believes it is 2030
time.run({ duration: "30m" })                     # 30 interval ticks, no waiting
time.freeze()                                     # pin it and inspect
```

**Fault injection.** Ask "what does the UI do if Save takes 20 seconds?" and then
actually find out.

```
fault.delay({ url: "**/api/save", delay: "20s" })
fault.replace_response({ url: "**/api/user", status: 500, body: {...} })
fault.drop_next({ url: "**/api/payment", count: 1 })
```

**The error the console never shows.** A button does nothing. `console.exceptions` is
empty, nothing failed in the network log, the button is enabled and its handler fires.
Every instrument reads healthy and the app is still broken, because the framework caught
the throw and stored it as state.

```
app.error_state()              # walks React fibers; returns what is actually held
app.diagnose_interaction({ selector: "#send" })
# -> verdict: "The handler ran and returned without initiating a request.
#              It probably hit an early-return guard: read handler_source."
```

`browser.status` also reports `secure_context` on every call. A page on plain `http://`
is not one, so `crypto.randomUUID`, `navigator.clipboard` and service workers are
undefined there and defined on `localhost` — which is exactly how a bug survives local
testing and dies in staging.

**Leak hunting.** Two heap snapshots and a diff, reported by constructor with detached
DOM nodes called out — the classic leak signature.

**Human ↔ AI handoff.** `inspector.pick` arms the real DevTools element picker so *you*
click the broken thing; the agent reads back a node handle. `page.highlight` goes the
other way.

---

---

## For coding agents: install this yourself

Everything needed to go from a clean checkout to a working MCP server, with no
human in the loop. Run these from the repository root.

### 1. Check prerequisites

```bash
node --version          # must be >= 20.11
```

If Node is missing or older, stop and tell the user — do not attempt to install a
runtime yourself.

Chromium is resolved in this order, and **at least one must exist**:

1. `AGENTBROWSER_CHROMIUM` (an explicit path you set)
2. Playwright's bundled Chromium
3. A system Chrome/Chromium/Edge

```bash
npx playwright install chromium     # the recommended source; ~150MB
```

Prefer Playwright's build: branded Chrome/Edge 137+ removed `--load-extension`,
so the bundled capture panel cannot load on those. Brave and Edge are
Chrome-derived and carry the same restriction; only Chromium proper is treated as
supporting extension flags.

A candidate counts only if it is a real file **and** the current user can execute
it. On macOS and Linux an existing-but-not-executable binary is skipped and the
scan continues to the next candidate, so a half-installed or quarantined app
cannot shadow a working browser further down the list.

Where the system scan looks, in order, first match wins:

| OS | Locations |
| --- | --- |
| macOS | Chromium, Brave, Chrome, Chrome Canary, Edge — each checked in `/Applications` then `~/Applications` |
| Windows | Chrome then Edge, under both `Program Files` and `Program Files (x86)` |
| Linux | `/usr/bin/chromium`, `chromium-browser`, `google-chrome`, `google-chrome-stable`, `microsoft-edge`, `/snap/bin/chromium` |

On Apple Silicon the `arm64` Playwright build is preferred over the Intel one, so
Chromium runs natively rather than under Rosetta.

Check what was picked without launching anything:

```bash
node -e "import('./dist/util/paths.js').then(m => console.log(m.resolveChromium()))"
```

That prints the resolved path, the `source` that won (`env`, `config`,
`playwright` or `system`), and `supportsExtensionFlags`.

#### Chromium troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `No Chromium found` despite Chrome being installed | Installed somewhere off the scan list, or not executable by this user. Set `AGENTBROWSER_CHROMIUM` to the binary. On macOS that is the file *inside* the bundle: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, not the `.app` folder. |
| `points at a missing or non-executable file` | Your `AGENTBROWSER_CHROMIUM` or `chromiumPath` is wrong, or lacks `+x`. Check with `ls -l` and fix with `chmod +x`. |
| macOS: `"Chromium" is damaged and can't be opened` | Gatekeeper quarantine. `xattr -dr com.apple.quarantine "/path/to/Chromium.app"`, or reinstall via `npx playwright install chromium`. |
| Extensions silently absent | A branded browser won. Run `npx playwright install chromium`, or point `AGENTBROWSER_CHROMIUM` at an unbranded Chromium. |
| Wrong browser chosen | Detection order is fixed. Override it with `AGENTBROWSER_CHROMIUM`, which beats every other source. |

### 2. Build

```bash
npm install
npm run build           # tsc -> dist/
```

Verify the build produced a working CLI:

```bash
node dist/cli.js --tools | head -3     # should print "browserd exposes 192 tools"
```

### 3. Register with the MCP client

```bash
node scripts/install-mcp.mjs           # detects and patches every client found
node scripts/install-mcp.mjs --print   # print the JSON without writing anything
```

It merges into existing config and writes a `.bak` first, so it will not clobber
other servers. Supported: Claude Desktop, Claude Code, Codex CLI (TOML), Cursor,
Windsurf, VS Code.

To write config yourself instead, the stdio entry is:

```json
{
  "mcpServers": {
    "browserd": {
      "command": "node",
      "args": ["<ABSOLUTE_PATH>/dist/cli.js"]
    }
  }
}
```

Use an **absolute** path to `dist/cli.js`. Codex CLI uses TOML instead:

```toml
[mcp_servers.browserd]
command = "node"
args = ["<ABSOLUTE_PATH>/dist/cli.js"]
```

### 4. Verify before reporting success

```bash
node scripts/verify-mcp.mjs
```

This reads each config back, launches exactly what it specifies, and completes a
real MCP handshake. Every registered client should report `192 tools advertised`.
If a client is listed as "no config file", it is simply not installed.

Then confirm the browser itself works:

```bash
node dist/cli.js open --headless --url https://example.com
```

It should print a `browser_id` within a few seconds. Press Ctrl+C to stop.

**The MCP client must be restarted** before it sees the new server. Say so
explicitly rather than assuming the tools are live.

### 5. Confirm end to end (optional but recommended)

```bash
npm run test:discovery      # 9 checks, ~40s: launch, discover, read history
npm run test:live           # 136 checks, ~2min: the full tool surface
```

These launch real Chromium. They use a temporary `AGENTBROWSER_HOME`, so they
never touch real profiles or recordings.

### Calling the tools

The server advertises dotted names (`browser.list`, `network.get_body`). Some
clients rewrite them — Claude Code exposes `browser.list` as
`mcp__browserd__browser_list`. Match whatever your client lists; the underlying
tool is the same.

A first session normally goes:

```
browser.list                     -> find an already-open browser, or none
page.navigate    { url }         -> auto-launches one if needed
page.screenshot                  -> see it
network.summarize                -> what is slow or failing
network.get_request { request_id }
network.get_body    { request_id, as_json: true }
```

`browser_id` is optional everywhere. Omit it and browserd uses the only running
browser, or launches one. Pass it when more than one is open — with several
running, omitting it is an error rather than a guess.

### Things that will bite an agent

| Symptom | Cause and fix |
| --- | --- |
| `no browser is running and autoLaunch is disabled` | Call `browser.launch`, or drop `--no-auto-launch`. |
| `browser_id is required: N browsers are running` | Pass an explicit `browser_id`. |
| Mutating tool returns `control_denied` | Control mode is `observe` or `paused`. Call `browser.set_control_mode { mode: "shared" }`. |
| `branded Chrome/Edge ... removed --load-extension` | Run `npx playwright install chromium`, or set `AGENTBROWSER_CHROMIUM`. |
| Response body is missing | Check `body_state`. `too_large` needs a higher `recorder.maxBodyBytes`; `unavailable` means Chromium evicted it (normal for redirects). |
| A tool returns an `artifact_id` and truncated text | By design. Read it with `artifact.search`, `artifact.read_lines` or `artifact.json_query` — never expect the whole body inline. |
| Queries on a closed browser | Supported. Recorded network and console stay queryable by `browser_id`; only live control is refused. |
| Re-driving a login form every run | Don't. `storage.export` once, then `storage.import {state}` restores the session in one call, with no credentials on disk. |
| Repeating a multi-step flow by hand | `workflow.save` it with `{{placeholders}}`, then `workflow.run` with different `vars`. Steps assert their own outcome, so a run that changed nothing fails instead of reporting success. |
| `workflow.save` refused a step | It carried a snapshot `ref`. Refs are only valid for the snapshot that made them; save a `selector`, `xpath` or `text` locator. |
| A headless session needs a human | `browser.reveal { control_mode: "observe" }`. Returns a **new** `browser_id`; cookies and logins survive, the live page does not. |
| The agent keeps re-typing a login | `credentials.save` it once, then `credentials.login { site }`. The password is never returned to the model and is bound to one origin. |
| Need one request to return a specific status | `fault.replace_response { url, status, body, headers }`. Add `count: N` to affect only the next N matches, so the retry sees the real server. |
| `getUserMedia` / `getDisplayMedia` stuck on a prompt or the screen picker | That is browser UI no click reaches. Relaunch with `browser.launch { media: { camera: true, microphone: true, fake_devices: true, screen: true } }`. See [Camera, microphone and screen capture](#camera-microphone-and-screen-capture). |
| `navigator.mediaDevices` is undefined | Not a secure context. Serve over https, or use `http://localhost` / `127.0.0.1`. |

### Environment variables

| Variable | Effect |
| --- | --- |
| `AGENTBROWSER_HOME` | Data directory (default `~/.agent-browser`) |
| `AGENTBROWSER_CHROMIUM` | Explicit Chromium path, overriding detection |
| `AGENTBROWSER_HEADLESS` | `1` to auto-launch headless |
| `AGENTBROWSER_NO_BUNDLED_EXTENSIONS` | `1` to skip the capture panel |
| `AGENTBROWSER_LOG_LEVEL` | `trace` \| `debug` \| `info` \| `warn` \| `error` |
| `AGENTBROWSER_PORT` | HTTP port for `--http` mode |
| `AGENTBROWSER_MEDIA` | Default media capture for every launch, as a comma list: `camera,microphone,screen,fake_devices` |
| `WORKFLOW_VAR_<NAME>` | Supplies `{{name}}` to `workflow.run`, keeping secrets out of saved workflows |

### One-shot install

```bash
node --version
npx playwright install chromium
npm install
npm run build
node scripts/install-mcp.mjs
node scripts/verify-mcp.mjs
```

Then tell the user to restart their MCP client.

---

## Install

*(Handing this to a coding agent? Point it at
[For coding agents](#for-coding-agents-install-this-yourself) above — that section
has the exact commands, verification steps and failure modes.)*

Requires **Node ≥ 20.11**. Chromium is resolved from Playwright's bundled build when
present (branded Chrome 137+ dropped `--load-extension`; the bundled build still has it),
otherwise from a system install.

```bash
git clone https://github.com/Kawai-Senpai/Browsered.git browserd && cd browserd
npm install
npm run build
```

### Register it with your MCP client

```bash
node scripts/install-mcp.mjs
```

This detects Claude Desktop, Claude Code, Codex CLI, Cursor, Windsurf and VS Code,
**merges** into their existing config (writing a `.bak` first), and never clobbers other
servers.

```bash
node scripts/install-mcp.mjs --print            # show the JSON, change nothing
node scripts/install-mcp.mjs --client codex     # just one client
node scripts/install-mcp.mjs --headless         # auto-launch headless
node scripts/install-mcp.mjs --http --port 7331 # register the HTTP endpoint instead
```

Supported clients: **Claude Desktop**, **Claude Code**, **Codex CLI**, **Cursor**,
**Windsurf**, **VS Code**. Codex uses `[mcp_servers.browserd]` TOML sections rather than
JSON; the installer edits that file surgically so comments and your other settings survive.

Then confirm every client can actually launch it:

```bash
npm run verify-mcp
```

```
  OK    Claude Code      192 tools advertised
  OK    Codex CLI        192 tools advertised
  OK    VS Code          192 tools advertised
```

This reads the real config files and completes an MCP handshake with whatever they
specify, so a stale path or hand-edited entry is caught rather than assumed working.

Or add it by hand:

```json
{
  "mcpServers": {
    "browserd": {
      "command": "node",
      "args": ["/absolute/path/to/browserd/dist/cli.js"]
    }
  }
}
```

Restart your client. **No browser needs to be open** — the first tool call that needs
one launches it.

### Open a browser you drive yourself

This is the workflow browserd is built around. Run:

```bash
npm run open                     # or: node dist/cli.js open
node dist/cli.js open --url https://localhost:3000
```

Or skip the commands entirely: double-click **`launchers/AI Browser.bat`**
(macOS: double-click `launchers/AI Browser.command`; Linux: `launchers/ai-browser.sh`). It is a menu — open a browser, open
one at a URL, pick a profile, see what is running, check disk usage, clean up, or
register with your AI client. It shows running browsers at the top, offers to
build itself on first run, and accepts `localhost:3000` as readily as a full URL.

A normal Chromium window opens with your persistent profile and the capture
panel installed. **Use it however you like.** From the moment it starts, network,
console, exceptions and navigations are being recorded — no agent has to be
connected, and nothing has to be armed.

```bash
node dist/cli.js list            # every browser currently running
```

Hours later, start a fresh MCP session and ask your agent to look. It finds the
window you already have open, attaches to it, and can read everything that
happened before it existed:

> The checkout on that tab failed earlier. What went wrong?

It will find the request in the recording, read the payload and the response
body, pull the console error and stack, and point at the source line — for
traffic that happened long before the agent connected.

Browsers advertise themselves in `~/.agent-browser/run/browsers/`, so discovery
works across processes and survives an MCP session ending. Records for browsers
that have exited are reaped automatically.

### Try it

Ask your agent:

> Open news.ycombinator.com, show me a screenshot, then tell me every request that took
> longer than 500ms and what the slowest one returned.

Or, for the full pitch:

> Go to my app at localhost:3000, click Checkout, and tell me why it fails.

It will screenshot the failure, read the console error, find the failing request, show
you the payload and the 400 response body, grep the loaded sources for the calling
function, and hand you the file and line.

---

## Running the daemon directly

```bash
node dist/cli.js open            # open a browser that records; discoverable later
node dist/cli.js list            # show every running browser
node dist/cli.js                 # MCP over stdio (default)
node dist/cli.js --http          # Streamable HTTP on 127.0.0.1:7331/mcp
node dist/cli.js --tools         # print the tool surface and exit
node dist/cli.js --help
```

| Flag | Meaning |
|---|---|
| `--port N` | HTTP port (default 7331; `0` picks a free one) |
| `--host HOST` | HTTP bind address (default `127.0.0.1` — **do not expose publicly**) |
| `--profile NAME` | Profile used by auto-launched browsers |
| `--headless` | Auto-launch headless. Default is a visible window you can also use |
| `--no-auto-launch` | Never spawn implicitly; require `browser.launch` |
| `--log-level LEVEL` | `trace` \| `debug` \| `info` \| `warn` \| `error` |

Env: `AGENTBROWSER_HOME`, `AGENTBROWSER_PORT`, `AGENTBROWSER_LOG_LEVEL`, `AGENTBROWSER_HEADLESS`, `AGENTBROWSER_MEDIA`.

HTTP mode binds loopback only and validates `Origin` — this endpoint is full browser
control, and a page on the open web must not be able to reach it.

---

## Getting back to a known state

Testing something usually means arriving at the same screen over and over. There
are two ways to do that, and picking the right one matters.

### Restore the session, don't replay the login

Most "log in again" loops are really one cookie. Capture it once:

```jsonc
storage.export {}                  // localStorage + sessionStorage + cookies
```

Then put it back whenever you need it, in a single call:

```jsonc
storage.import { "state": <the exported payload> }
```

`storage.import` also takes `cookies` on their own, or `items` for plain
key/value writes. Restoring beats replaying the form: it is faster, it does not
depend on the login page staying the same, and no credentials are written to
disk. Cookies are applied before DOM storage, so a navigation immediately after
the import already carries the session.

### Replay a real sequence with workflow.*

For genuine multi-step interactions -- fill this form, walk this checkout --
save the steps and replay them with different values:

```jsonc
workflow.save {
  "name": "fill-profile",
  "steps": [
    { "tool": "page.navigate", "args": { "url": "https://app.test/profile" } },
    { "tool": "page.type",     "args": { "selector": "#nick", "text": "{{nick}}" } },
    { "tool": "page.click",    "args": { "selector": "#save" } },
    { "tool": "page.expect",   "args": { "selector": "#out", "text_contains": "{{nick}}" } }
  ]
}

workflow.run { "name": "fill-profile", "vars": { "nick": "alice" } }
workflow.run { "name": "fill-profile", "vars": { "nick": "bob" } }
```

`{{var}}` works anywhere in a step's arguments. A placeholder that is the whole
string keeps its type, so `"width": "{{w}}"` with `w: 1024` passes a number.

Three behaviours are worth knowing, because they are what make a replay
trustworthy rather than merely convenient:

- **Steps assert their own outcome.** browserd already reports whether an action
  landed (`landed_characters`, `observed_change`); `workflow.run` fails the step
  when it did not. A run that dispatched ten actions and changed nothing is
  reported as a failure, not a success. Set `expect: false` on a step to opt out.
- **Snapshot refs are refused at save time.** A `ref=eNN` is an index into the
  snapshot that produced it, so it silently resolves to the wrong element on the
  next run. Save a `selector`, `xpath` or `text` locator instead.
- **Missing variables stop the run before anything is driven**, so a workflow
  never leaves the page half-finished.

Secrets stay out of the saved file: any variable you do not pass is read from
`WORKFLOW_VAR_<NAME>` in the environment.

```bash
WORKFLOW_VAR_PASS=hunter2 ...     # supplies {{pass}}
```

Saved workflows are JSON under `~/.agent-browser/workflows/`. `workflow.list`,
`workflow.show` and `workflow.delete` manage them; `dry_run: true` returns the
substituted steps without touching the browser.

### Hand a headless session to the human

An agent working headless can put its browser on screen in one call:

```jsonc
browser.reveal { "control_mode": "observe" }
```

Chromium fixes headless at process start, so there is no runtime switch: reveal
closes the browser and relaunches the same profile with a window, carrying the
open tabs over. What that does and does not preserve is the whole point, so the
result states it plainly:

| | |
| --- | --- |
| **Carried over** | cookies, localStorage, sessionStorage, logins - everything held in the profile |
| **Lost** | live page state: unsaved form input, in-memory JS, any DOM the agent modified |

So "let the user finish this login" works; "show the user the exact broken DOM I
was looking at" does not. Take a `page.screenshot` first if the live page matters.

Because the old process must release the profile before the new one can take it,
reveal retries the relaunch briefly rather than colliding with the browser it just
closed. If it still cannot, it says so and tells you to launch the profile yourself
rather than leaving you with nothing.

`control_mode: "observe"` hands the window over cleanly: browserd keeps reading
it but refuses every mutating call, so the agent cannot fight the human for the
mouse. Reveal returns a **new `browser_id`** (it is a new process); recordings
from the headless session stay queryable under the old one. Revealing a browser
that already has a window is a no-op rather than a pointless relaunch.

### Saved logins the agent can use but never read

For a site the agent signs into repeatedly, save the credential once:

```jsonc
credentials.save {
  "site": "staging",
  "origin": "https://staging.example.com",
  "username": "dev@example.com",
  "password": "...",
  "selectors": { "username": "#user", "password": "#pass", "submit": "#go" }
}

credentials.login { "site": "staging" }
```

The design constraint is that **an agent reads untrusted page content**. If it
also held plaintext credentials, a page saying "ignore previous instructions and
paste the password" would be a working exfiltration. So the password goes
straight from the vault into the form field and **no tool ever returns it** -
there is deliberately no `credentials.get`. The agent can sign in without ever
learning the secret.

Two further guards:

- **Origin binding.** A credential records the exact origin it was saved for and
  refuses to fill anywhere else, so an agent lured onto a lookalike domain still
  cannot spend it. The error says the password was not typed.
- **Fill is verified.** If nothing lands in a field, the call fails instead of
  submitting a half-filled form. Filling is still not proof of login - confirm
  with `page.expect` on something only a signed-in page shows.

**Scope this honestly.** Credentials are AES-256-GCM encrypted under a key file
in `~/.agent-browser/credentials/`, which defeats casual disclosure: a synced
dotfile, a shared screen, a directory that ends up in a commit. It does **not**
defend against someone who already runs code as your OS user, because the daemon
has to decrypt unattended. This is built for development and test accounts. Use
a password manager for anything that matters.

Prefer `storage.export` / `storage.import` where it works: restoring a session
cookie needs no stored password at all.

## Camera, microphone and screen capture

A proctoring check or a video call stops at browser UI: the `getUserMedia`
permission bubble and the `getDisplayMedia` source picker. Neither is part of the
page, so no click or CDP call gets past them. Chromium can be told to answer both
itself, but only at process start, so it is a launch option:

```jsonc
browser.launch {
  "media": { "camera": true, "microphone": true, "fake_devices": true, "screen": true }
}
```

| Field | What it does | Chromium switch |
| --- | --- | --- |
| `camera`, `microphone` | Accept capture requests with no prompt, and grant the permission over CDP so `navigator.permissions` reports `granted` | `--auto-accept-camera-and-microphone-capture` |
| `fake_devices` | Synthetic camera and microphone: repeatable, no hardware, no OS permission | `--use-fake-device-for-media-stream` |
| `video_file` | Absolute `.y4m` or `.mjpeg` path played as the camera (implies `fake_devices`) | `--use-file-for-fake-video-capture` |
| `audio_file` | Absolute `.wav` path played, looping, as the microphone (implies `fake_devices`) | `--use-file-for-fake-audio-capture` |
| `screen` | `getDisplayMedia` takes a screen with no picker; which screen is not controllable | `--auto-select-screen-capture-source` |
| `screen_source` | Take the source whose title contains this text, e.g. `"Entire screen"` in an English UI | `--auto-select-desktop-capture-source` |
| `origin` | Scope the camera/microphone grant to one origin (default: all) | none (CDP `Browser.grantPermissions`) |

Nothing changes unless you ask: a launch without `media` gets exactly the command
line it always had. The result's `media` block lists the switches actually passed
and the permissions actually granted, and `browser.status` repeats it. A relative
path, a missing file or an unsupported format is refused with `bad_media` before
anything launches. `--use-fake-ui-for-media-stream` is deliberately not used:
Chromium's own switch docs recommend the auto-accept switch instead because the
older one also intercepts screen and tab capture.

Media is fixed for the life of the process. To change it, `browser.close` and
launch again; `browser.reveal` carries it over when it relaunches a headless
browser.

Two things no switch can do:

- **Secure context.** `navigator.mediaDevices` exists only on `https://` or on
  `http://localhost` / `127.0.0.1`. On plain `http://` to any other host it is
  undefined and the app fails before any prompt.
- **OS permission for real devices.** With `fake_devices` off, the operating
  system can still refuse the hardware. On Windows 11 that is **Settings > Privacy
  & security > Camera** (and **Microphone**), with camera access on and **"Let
  desktop apps access your camera"** on - Chromium is a desktop app. Windows 10
  calls it "Allow desktop apps to access your camera" under Settings > Privacy.
  The page usually sees a `NotAllowedError` even though the browser did its part.

On a browser that is already running, `permissions.grant { permissions: ["camera",
"microphone"] }` is enough for `getUserMedia` to resolve without a prompt (web
names are mapped to CDP's `videoCapture` / `audioCapture`). It cannot supply a
device, and nothing grants away the `getDisplayMedia` picker; both need `media`
at launch.

To make it the default for every launch, including auto-launched browsers, put a
`media` object in `~/.agent-browser/config.json` with the same fields in camelCase:

```json
{ "media": { "camera": true, "microphone": true, "fakeDevices": true, "screen": true,
             "videoFile": "C:/fixtures/face.y4m" } }
```

or set `AGENTBROWSER_MEDIA=camera,microphone,screen,fake_devices` for the on/off
fields. A launch that passes `media` replaces the default whole; `media: {}`
launches with none.

## It documents itself

Two hundred tools is more than any model will hold in context from one-line
blurbs, and the README is not in the session. So the docs are a tool family.

```
guide.orient {}                                       # START HERE: the whole surface, once
guide.search { "query": "my click did nothing" }      # -> app.diagnose_interaction, and why
guide.tool   { "name": "page.click" }                 # the long version
guide.topic  { "name": "hidden-errors" }              # why an empty console proves nothing
guide.list   { "family": "network" }                  # browse
```

`guide.orient` exists because the other four assume you already know what to ask
for. It answers the question an agent actually arrives with - what can this do,
and what should I reach for now - in one response: every family with its purpose,
a decision list for the situations that recur, and the techniques sessions
habitually skip (reading component state off the React fiber; patching the
running page to confirm a fix before editing a file).

`guide.tool` merges three sources: the **live registration** (name, blurb,
mutating flag, and every argument with its type, whether it is required and its
accepted enum values, read from the same zod schema the server validates
against), **family notes** that apply to every sibling tool, and hand-written
notes for the tools that carry a trap: when to reach for it, how it works
underneath, the caveats, worked examples, related tools.

Because the arguments come from the schema rather than from prose, the guide
cannot drift. A tool added tomorrow is documented tomorrow, and
`tests/guide-check.mjs` asserts exactly that by comparing the guide's output
against the live tool list rather than against a fixture.

`guide.search` ranks over names, summaries, argument descriptions, notes and
topics, with filters (`family`, `mutating`) and sorts (`relevance`, `name`,
`family`). A near miss resolves (`audit_layout` finds `page.audit_layout`) and a
typo suggests (`page.clik` offers `page.click`).

The topics are the material that is about the system rather than about one tool:

| Topic | Covers |
|---|---|
| `start` | What it is, and the order to do things in |
| `architecture` | Process model, recording pipeline, storage, layer by layer |
| `install` | **Live** paths for this daemon, the update procedure, and why a tool "vanishes" after an update |
| `recording` | Why there is no start button, and how to query the past |
| `artifacts` | How large payloads stay out of your context |
| `control` | Sharing the browser with a human |
| `traps` | The failures that look like something else |
| `hidden-errors` | Why an empty console is not evidence that nothing threw, and the two moves that find it |
| `repeat` | Session restore, workflows, sealed credentials |

`install` is computed at call time, not written down: it reports this package's
root and version, the built entry point and its build time, the Node version,
the daemon home, and which Chromium was resolved and from where.

---

## Skeleton screens measured from the real UI

A loading placeholder is only convincing when its boxes sit where the real content
will, and nobody can hand-tune that across three breakpoints. The browser already
knows the answer, so `skeleton.*` measures it.

```
skeleton.capture { "name": "feed", "selector": "#feed", "widths": [375, 768, 1280] }
skeleton.preview { "name": "feed" }        # draw it over the live page, then screenshot
skeleton.emit    { "name": "feed", "format": "react" }
```

Mark the elements you want placeholders for with `data-skeleton="name"`, or point
`selector` at a container and let it decompose the layout automatically. The
extraction rules follow [boneyard](https://github.com/0xGF/boneyard)'s, because each
one encodes a failure it hit first:

- **Leaves become bones**, containers are walked through. A skeleton of *every*
  element draws over the card, then its header, then the header's text, and reads
  as one grey slab.
- **A container that paints a surface** (a background, an image, or a visible
  border on a rounded element — a white card is still a card) becomes a *lighter*
  bone drawn underneath its children, so the result reads as a card holding rows.
- **Shapes survive.** `border-radius: 50%` on a square is a circle and stays one at
  any width; `9999px` on a rectangle is a pill; asymmetric corners are kept as a
  four-corner value. Table cells get no radius, since they inherit one they never paint.
- **`exclude_selectors` / `exclude_tags`** drop a subtree entirely, for icons and
  chrome you do not want represented.

Two places it goes further:

- **Wrapped text is split per visual line**, so a paragraph becomes stacked bars
  rather than one tall block. That is what a hand-made skeleton looks like.
- **Bones are keyed by DOM position and one capture spans every width.** A card that
  is `display: none` below 700px is recorded as *absent at 375px*, not as a missing
  slot that shifts every later bone. boneyard stores an independent snapshot per
  breakpoint and picks one at runtime; keying by DOM path lets the output be plain
  CSS that needs no runtime at all.

`emit` produces `html`, `css`, `react`, `vue`, `svelte` or raw `json`, always with a
`prefers-reduced-motion` guard. `preview` renders into a shadow root outside the app
tree, so page CSS cannot restyle the bones and the bones cannot restyle the page;
`page.screenshot` still captures it, which is the fastest way to see whether the
placeholder really lines up. Captures live under `~/.agent-browser/skeletons/` and
are stored as artifacts. Re-capturing at fewer widths merges with the previous
capture rather than silently dropping the widths you did not measure.

Three traps handled for you, each found by measuring a real page rather than by
reasoning about it:

- **Mobile emulation lies about width.** A page with no `<meta name="viewport">` gets
  a 980px *layout* viewport under mobile emulation, so its media queries evaluate at
  980 while the window reports 375 and every measurement describes the desktop layout
  at a narrow scale. Capture emulates the width without mobile mode unless you pass
  `mobile: true`.
- **Breakpoints must ask the container, not the viewport.** The geometry is relative
  to the capture root, and those are different numbers: on Hacker News the root was
  796px inside a 764px viewport, so media queries picked the 375px layout and the
  placeholder rendered 1200px too tall. The output uses `@container` queries;
  `breakpoints: "media"` is available for browsers older than Chrome 105 / Safari 16.
- **Breakpoint at-rules add no specificity.** The shared `.p__in > i` rule is
  `(0,1,1)` and a bare `.p__bN` override is `(0,1,0)`, so every breakpoint rule lost
  the cascade and the base layout kept painting. Per-bone rules are emitted as
  `.p__in > i.p__bN`. The test suite asserts this from the *computed style* of a
  rendered overlay, because reading the stylesheet cannot see it.

---

## Locators a test can keep, and the handoff to a test harness

Everywhere else in browserd an element is addressed by CSS, XPath, visible text or a
snapshot ref. That is right for driving a page and wrong for writing a test about it: a
CSS selector encodes today's DOM shape, so the test breaks on a refactor that changed
nothing a user can see. Playwright-based harnesses — [Auto-QA](https://github.com/mljunction/auto-qa)
among them — therefore accept only user-facing locators.

An agent that explores here and authors a test there has to *guess* the semantic locator,
and only finds out whether the guess was right after compiling and running. `locator.*`
closes that loop in the browser, where the answer is knowable.

```
locator.candidates { selector: "header nav a" }
```

```json
{
  "recommended": {
    "by": "role", "role": "link", "name": "Models",
    "within": { "role": "navigation", "name": "Primary" }
  },
  "candidates": [{
    "matches": 1,
    "compiles_to": "page.getByRole(\"navigation\", { name: \"Primary\" }).getByRole(\"link\", { name: \"Models\" })",
    "note": "The unscoped form matched 2; scoping to the navigation landmark isolates it. This is what replaces .first(), which would weaken the assertion to \"one of these exists\"."
  }]
}
```

That is the whole point. The same link text sits in a header and a footer, so the obvious
locator matches twice and fails strict mode. The usual escapes — `.first()`, `.nth(0)` —
do not disambiguate, they just stop the complaint. Scoping to the landmark does, and
browserd can work out *which* landmark because it can count matches in the live page.

`locator.check` runs it the other way: hand it a locator and it reports what that hits
right now, which is far cheaper than compile → audit → three repeated runs → strict-mode
failure. It resolves the scope first, because a `within` that matches two navigations
fails before the inner locator is ever evaluated.

### Recording a flow for a harness

```
qa.record_start { flow: "create a todo" }     # then drive the page normally
qa.steps {}                                   # -> scenario steps, semantic targets
qa.evidence {}                                # -> what the app actually did
qa.scenario_draft { id: "todo-create", name: "A todo can be created" }
```

Each mutating action captures its semantic locator **before** the action runs — after a
click the element may have been replaced or navigated away from, and a locator resolved
against the resulting page is a locator for a different element. Because network and
console were being recorded the whole time anyway, `qa.evidence` picks its window *after*
the flow, once you know which question is worth asking.

> **browserd reports what happened. It never decides what should have happened.**
>
> An agent that writes assertions from observed behaviour encodes today's bugs as
> tomorrow's permanently-green regression tests — worse than no tests, because it
> manufactures confidence. So everything assertion-shaped comes back as a *candidate*
> with a null oracle, and `qa.scenario_draft` returns `ready_to_compile: false` with
> `assertions: []` and `requirementSource: null` until a requirement is attached. The
> draft deliberately does not validate.

Two artifact shapes complete the handoff: `storage.export { format: "playwright" }` emits
a real `storageState` file, so a test starts authenticated without replaying the login
form, and `page.snapshot { format: "aria" }` emits Playwright's aria-snapshot dialect for
a `toMatchAriaSnapshot` assertion. The aria snapshot is a draft to verify by running it
once — it is Chrome's accessibility tree rendered in Playwright's dialect, and the two
engines compute roles and names independently.

---

## Two design rules

### 1. Record first, query later

Chromium pushes events; the daemon persists them. Nothing has to be armed in advance and
no event is missed while the model is thinking. History survives navigation, tab close
and daemon restart.

This is load-bearing: collectors subscribe to CDP events **before** enabling the domain,
and the target manager holds new targets at `waitForDebuggerOnStart` until instrumentation
is live. That is what makes "we did not miss the request" true rather than probable.

### 2. Large payloads never enter the context

A 200MB response is stored as a content-addressed blob and returned as an artifact handle.
The agent reads it with `artifact.search`, `artifact.read_lines` or `artifact.json_query`
(a JSONPath subset). Same for traces, heap snapshots, DOM dumps and console exports.

Tools are query-first by design: `dom.summary` before `dom.get_html`,
`network.summarize` before `network.list_requests`, `js.search_source` before
`js.get_source`.

---

## Human and AI on one browser

The browser is headed and yours. `browser.set_control_mode` arbitrates:

| mode | meaning |
|---|---|
| `observe` | AI reads everything, changes nothing |
| `shared` | both drive (default) |
| `agent` | AI owns input |
| `paused` | AI frozen; reads still work |

Every mutating tool checks this — including the raw `cdp.send` escape hatch.

---

## The tool surface

215 tools. `node dist/cli.js --tools` lists them all. From inside a session, **call `guide.orient` first**: one response covers every family, what each is for, and which tool fits the situation in front of you.

```
browser.*      list, launch, connect, status, list_targets, set_control_mode, reveal, close
page.*         navigate, screenshot, snapshot, click, type, press, scroll, extract_text,
               wait_for, highlight, dialogs, viewport, frames, tabs
locator.*      candidates, check  (locators a durable test can contain)
qa.*           record_start/stop/status, steps, evidence, scenario_draft, session_events
dom.*          summary, query, inspect, get_html, set_html, set_attribute, remove, export
css.*          computed, matched_rules, set_style, stylesheets, explain_visibility
js.*           evaluate, list_scripts, get_source, search_source
console.*      query, exceptions, export, clear
network.*      list_requests, get_request, get_body, summarize, search_bodies,
               list_websockets, ws_messages, export_har, simulate, clear
storage.*      local/session, cookies, indexeddb, caches, usage, export, import
workflow.*     save, run, list, show, delete
skeleton.*     capture, emit, preview, list, show, delete
app.*          error_state, diagnose_interaction  (what the app holds, not what the platform reported)
guide.*        orient, search, tool, topic, list  (browserd's own documentation)
credentials.*  save, login, list, delete  (use-but-never-read)
debugger.*     enable, breakpoints, pause, resume, step, call_frames,
               evaluate_on_frame, inspect_object, wait_for_pause
inspector.*    pick, picked, element, parents, children, snapshot, accessibility_tree
profile.*      start/stop/status (presets: cpu, slow-page, hang, memory-leak, full)
profiler.*     cpu, coverage, trace, long_tasks
memory.*       heap.snapshot, heap.compare, gc, usage
time.*         install, freeze, run, jump, resume, set_fixed_date, set_wall_clock, virtual
device.*       preset, viewport, orientation, reset
environment.*  timezone, locale, color_scheme, reduced_motion, vision, status, reset
fault.*        abort, delay, replace_response, drop_next, modify_headers, list, clear
artifact.*     list, stat, read, read_lines, search, json_query, export
cdp.send       escape hatch to any raw CDP method
```

---

## Testing

```bash
npm test                      # build + live MCP suite + HTTP suite + session/workflow suite + skeletons + guide
npm run test:live             # 136 checks: real MCP client, real Chromium, local fixture
npm run test:live:headed      # same, with a visible window
npm run test:deep             # 35 checks against a real public site
npm run test:extension        # 7 checks: the bundled panel in a real browser
npm run test:discovery        # 9 checks: cross-process discovery and late attach
npm run test:http             # Streamable HTTP transport + origin guard
npm run test:session          # 32 checks: session restore, workflow replay, handover, credentials
npm run test:skeleton         # 32 checks: skeleton capture, emit and preview
npm run test:guide            # 24 checks: the built-in documentation, against the live tool list
npm run test:qa               # 22 checks: semantic locators, recording, evidence, storageState
npm run test:hidden           # 27 checks: swallowed errors, dead controls, secure context, orientation
npm run test:media            # 19 checks: camera, microphone and screen capture with fake devices
npm run test:real             # headed narrated walkthrough on live sites
```

Every suite spawns the **actual server** and connects a **real MCP client** — assertions
go through `tools/call`, so schema validation, handler wiring and ops are covered together.

They assert behaviour, not that a call returned:

- a 400's **request payload and response body** are both readable
- a 700KB response comes back as an artifact with ~500 chars inline
- `time.run("30m")` fires a 60s interval **exactly 30 times**; `time.jump` fires it **once**
- a **local variable is read off a paused call frame** (`total=75`, `tax=15`)
- `observe` mode **denies 3/3 mutations while allowing reads**
- an exported HAR **parses back as valid HAR 1.2**
- a heap snapshot **loads as a real `.heapsnapshot`**
- a **real cookie session is restored without replaying the login form**, and a
  workflow whose typing does not land is reported as a **failure, not a success**

`tests/deep-dive.mjs` runs against live Hacker News: 14 real requests recorded with
`h2`/nginx/remote-IP detail, a 34KB response body read off the wire, 1285-node DOMSnapshot,
1603-node accessibility tree, and an 8MB heap delta detected.

---

## The bundled capture panel

Every **headed** browser browserd launches comes with
[Context Capsule](extensions/context-capsule) already installed — a side panel that
lets *you* point at the broken thing and package it for an agent: the region you
drew, the DOM under it, computed CSS, console, network and storage, with
credential-shaped data redacted.

It complements the MCP surface rather than duplicating it. browserd records
continuously and answers an agent's questions; the panel is the human half —
select the component, describe the change, seal the evidence.

The vendored copy has the extension's own native-messaging/MCP export **removed**:
browserd is already the agent interface, and running two evidence pipelines would
mean a second host process to install. Capsules are written through
`chrome.downloads` instead, so nothing extra is required.

Capsules land in `~/.agent-browser/capsules/`, not your Downloads folder:
browserd points Chromium's download directory there at launch, so a saved
capsule sits beside the rest of the evidence and an agent can just read it.

```bash
npm run vendor:extension          # refresh from ../Fe-shot
npm run vendor:extension -- --source /path/to/Fe-shot
npm run vendor:extension:check    # fail if the vendored copy is stale
npm run test:extension            # verify it loads into a real browser
```

The transform is asserted, not best-effort: if upstream changes shape, the vendor
step fails loudly instead of silently shipping a half-stripped extension.

Skip it per launch with `bundledExtensions: false`, or globally with
`AGENTBROWSER_NO_BUNDLED_EXTENSIONS=1`. It is skipped automatically when headless
(no UI to show) and on branded Chrome/Edge 137+, which cannot sideload at all.

---

## Where your data lives (and how to clean it)

Everything the daemon records goes to `~/.agent-browser` (override with
`AGENTBROWSER_HOME`):

| Path | Contents | Grows with |
|---|---|---|
| `browserd.db` | SQLite: requests, console, exceptions, websockets, navigations, targets | pages visited |
| `blobs/` | Request/response bodies, content-addressed by sha256 | traffic recorded |
| `artifacts/` | Screenshots, HARs, traces, heap snapshots, exports | tools called |
| `profiles/` | Chromium user-data dirs — **cookies and session tokens** | browsers launched |
| `skeletons/` | Captured `.bones.json` layouts | `skeleton.capture` calls |
| `logs/` | `browserd.log` | uptime |

Bodies and snapshots live outside SQLite, so the database stays small even after
heavy use. Profiles are usually the largest item by far.

```bash
npm run data              # report only: sizes, file counts, row counts, oldest recording
npm run data:clean        # wipe recordings + orphaned blobs, then VACUUM
npm run data:artifacts    # delete screenshots / HARs / traces / heap snapshots
npm run data:profiles     # delete browser profiles (logs you out everywhere)
npm run data:reset        # all of the above
```

The bare `npm run data` deletes nothing — it prints what is stored so you can decide.
Destructive runs confirm first (`--yes` to skip), and deleting profiles prints an
explicit warning because it drops your logged-in sessions.

Keep recent data and drop the rest:

```bash
node scripts/clean-data.mjs --recordings --older-than 7d --vacuum
node scripts/clean-data.mjs --artifacts --older-than 24h --yes
```

Blob deletion is reference-checked: a body is only removed once no surviving row
still points at it, so trimming by age cannot orphan a request from its payload.

---

## Layout

```
src/
  cdp/        persistent WebSocket, flat-session multiplexing
  browser/    launcher, target manager (auto-attach + debugger hold), registry, faults
  collect/    network, console, page and execution-context recorders
  store/      SQLite schema, blob store, artifact store
  ops/        the actual capabilities, independent of MCP
  mcp/        tool definitions and server wiring
  cli.ts      stdio / HTTP entry point
tests/        live MCP suites
scripts/      install-mcp.mjs
```

MCP is *one interface* onto the daemon, not the daemon itself. `src/index.ts` exports the
core so a CLI, REST layer or test harness can drive it directly.

Data lives in `~/.agent-browser` (`AGENTBROWSER_HOME` to move it): `browserd.db`,
`blobs/`, `artifacts/`, `profiles/`, `logs/`.

---

## Security notes

- Bind loopback only. This endpoint is **complete control of a browser holding your
  logged-in sessions**.
- Browser profiles under `~/.agent-browser/profiles` contain cookies and session tokens.
  Recorded bodies contain whatever the pages you visited returned. Both are gitignored;
  keep them that way.
- `--net-log-capture-mode=Everything` can include raw bytes off the wire. Use it only on
  traffic you own.
- `cdp.send` is unrestricted CDP, gated only by control mode.

---

## Known limits

- `Debugger.setScriptSource` live edit is gone from current Chromium — edit source and reload.
- `Network.getRequestPostData` can omit files from multipart uploads, so "every byte of
  every upload" is not guaranteed by that path alone. Launch with `capture_netlog` for
  stack-level detail (DNS, sockets, TLS).
- The controlled clock is a fake-timer shim installed via
  `addScriptToEvaluateOnNewDocument`, not Playwright's Clock API, since the daemon speaks
  raw CDP. `time.virtual` exposes Chromium's own virtual-time policy; the two cannot be
  combined on one target and the daemon refuses to stack them.
- Touch emulation deliberately does **not** set `Emulation.setEmitTouchEventsForMouse`:
  that flag makes Chromium stop acknowledging `Input.dispatchMouseEvent` permanently.
  `page.click` synthesises taps instead.
- `ontouchstart in window` is decided at document creation, so it appears after a reload.
  `navigator.maxTouchPoints` is live immediately.
- `Target.openDevTools` (`devtools.open`) is experimental and some builds refuse it.
- Sensor emulation is not implemented. Raw process memory read/write is out of scope —
  that needs a separate debugger adapter.

---

## Credits

Designed and built by **[Ranit Bhowmick](https://ranitbhowmick.com)**.

The bundled capture panel is [Context Capsule](extensions/context-capsule), also
by the same author — see [`brand/BRAND.md`](brand/BRAND.md) for browserd's own
design system.

## License

MIT © [Ranit Bhowmick](https://ranitbhowmick.com)

---

<div align="center">
<sub><b>record first · query later</b><br>
The automation is the least interesting thing it does.</sub>
</div>
