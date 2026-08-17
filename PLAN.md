so are you sure the AI will be able to see the browser, tabs, take screenshots for itself to SEE the window, navigatem click on things. scroll. extract etext, an do muchc more !! just liek a human and a real automated web browser, liuke a AI agent. but along with that it should be able to READ CONSOLE LOGSS !! EXECUITE CONSOLE LOGS !! READ NETWORK TAB !! ALL HEADER, it should see payload so that it can debug it !! it should also see the response for it so that it can actually debug that as well !! and so on !! also it should be able to save or dump any network http in a file, or jso so that it canprogramatcially explore it beaus ethese ar ebig it can t always inject it sineatd it shoudl supply a path and export it or mutlipe lines fo rcolse logs, logs slicing by time, etc same fo rnetwork  !! thats what i want same for seeing the html and seeing stuffs because sometime we want the ai to se wht something doenst look or work a certain way so seeing that html or css or js will make it saolve it easily !! also maybe highlight

you remember what we are kaing rtight ??

@Web search I want to give a AI agent access o a browser, it can use browser automation, playwright or whatever to navigate, see whatever i have opened in that browser, apart form tha i can use it normally. it should be balso bal eto control te browser, etc bla bla, it shoudl also be able to see all consolve log, acess all tyhe html, css, js content, it should also be bale to modify them if needed. but most and most importantly it should be aable to acess lal debug functionlity and ACESS FUKK NETWORK LOGS< EACH EREQUEST< PAYLOAD< HEADER AND RESPONSE PROPERLY IN DETAILED WAY !!!!!!!!!!!  
now a simple extension will not make this amount of thing possible
so i was thinking how about i can write a custom driver or something?? in pyhn , jabvascript of whatever is best. so9 i spawn my own browser !?? and on the other side it connects to the AI using a MCP !! in a way that the mcp multiple instances can also discover and conenct to mulstipe instances of the browser !! if its running 

and i can also preinstall andopen up my own debug extensions that i have developed as it opens up ?? 

How cna i also expose the debugger the session straoge, memory acess, etcas wlel to the AI. so that it can actually read and edit session stroages, memeory stuffs use the debigger in a browser and also actually use the inspector !! that eac broser has somehow ? you can have specialized tools for that as well 

also i would love to have profilers to provile ansd see what takes time, what hancds, what stuck, to see and measure footprints, profiles, etc bla bla

also for automated tetsing controling the time and clock of the broser, speding things up, chaging things, etc that is also useful and i also want to hav ethat so that the AI can do those with rpoepr  dedicated tools and functionality 

Yes. **This is absolutely buildable**, and I would not build a custom “browser driver” from scratch.

The clean architecture is:

```text
                        ┌─────────────────────────┐
                        │      AI / Agent         │
                        │ Claude / GPT / IDE etc. │
                        └────────────┬────────────┘
                                     │ MCP
                                     ▼
                    ┌───────────────────────────────┐
                    │       Browser MCP Server      │
                    │        + Browser Broker       │
                    │                               │
                    │ browser.list()                │
                    │ tabs.list()                   │
                    │ page.click()                  │
                    │ page.evaluate()               │
                    │ network.requests()            │
                    │ network.get_request()         │
                    │ network.get_response_body()   │
                    │ console.logs()                │
                    │ debugger.*                    │
                    │ cdp.send()   ← escape hatch   │
                    └──────────────┬────────────────┘
                                   │
                   registry / instance_id routing
                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
              Browser A       Browser B       Browser C
              Chromium        Chromium        Chromium
              Profile A       Profile B       Profile C
                    │              │              │
                 CDP WS          CDP WS          CDP WS
                    │
            ┌───────┴────────┐
            │ Playwright     │
            │ Raw CDP        │
            │ NetLog         │
            │ Extensions     │
            └────────────────┘
```

That gives you almost exactly the monster debugging browser you're describing.

## The critical piece: CDP

**Chrome DevTools Protocol is effectively the low-level driver you want.**

Playwright and Puppeteer are convenient higher-level controllers, but CDP is what Chrome DevTools itself talks to for a huge amount of debugging functionality.

Playwright lets you create a raw `CDPSession`, and it can also attach to an already-running Chromium instance through `connectOverCDP()`. ([Playwright][1])

So your stack should probably be:

```text
TypeScript / Node.js
        │
        ├── Playwright
        │      └── navigation, clicks, typing, tabs, screenshots
        │
        ├── Raw CDP
        │      └── Network, Debugger, Runtime, DOM, CSS, Profiler...
        │
        ├── persistent event/database layer
        │      └── network requests, console, errors, target events
        │
        └── MCP server
               └── exposes everything cleanly to the AI
```

I would personally use **TypeScript/Node** rather than Python for this particular project. Python can certainly do it, but CDP, Playwright, Puppeteer and MCP all fit very naturally into an event-driven Node application.

---

### And yes: you can use the browser normally yourself

Run **headed Chromium**, not headless.

You get a normal browser window. You can click around, log into websites, type, navigate, use tabs, etc. Your controller remains attached and sees the tabs/pages.

Playwright's persistent context gives you a normal persistent browser profile containing cookies, local storage and other state. Current Playwright documentation specifically recommends using a separate automation profile rather than your default Chrome profile. ([Playwright][2])

For example, conceptually:

```ts
const context = await chromium.launchPersistentContext(
  "./profiles/browser-001",
  {
    headless: false,
    channel: "chromium"
  }
);
```

Then your agent and you are looking at **the same live browser**.

There is one engineering problem you'll need to solve: simultaneous human + AI control.

If you're clicking while the AI clicks something else, chaos is possible.

I'd implement:

```text
CONTROL MODE

observe
    AI may inspect everything but cannot interact

shared
    AI may interact while user is using browser

agent
    AI currently owns input

paused
    AI cannot perform mutations
```

And give the human an obvious emergency toggle.

---

# Your NETWORK requirement

This is where your architecture makes much more sense than an extension.

CDP's `Network` domain exposes request and response events and includes methods such as `Network.getRequestPostData` and `Network.getResponseBody`. The `requestWillBeSentExtraInfo` / `responseReceivedExtraInfo` events provide additional header/cookie information, including refined request headers that were actually transmitted. ([Chrome DevTools][3])

So you can build an internal record like:

```ts
interface NetworkRequest {
  id: string;

  url: string;
  method: string;

  requestHeaders: Record<string, string>;
  requestHeadersExtra: Record<string, string>;

  requestBody?: Buffer;

  resourceType: string;
  initiator: unknown;

  status?: number;

  responseHeaders?: Record<string, string>;
  responseHeadersExtra?: Record<string, string>;

  responseBody?: Buffer;

  mimeType?: string;

  timing?: unknown;

  remoteIPAddress?: string;
  protocol?: string;

  fromDiskCache?: boolean;
  fromServiceWorker?: boolean;

  startedAt: number;
  completedAt?: number;
}
```

Your collector listens continuously.

```text
Network.requestWillBeSent
Network.requestWillBeSentExtraInfo

Network.responseReceived
Network.responseReceivedExtraInfo

Network.dataReceived
Network.loadingFinished
Network.loadingFailed

Network.webSocketCreated
Network.webSocketFrameSent
Network.webSocketFrameReceived
...
```

When `loadingFinished` arrives:

```text
Network.getResponseBody(requestId)
```

Then persist it.

CDP explicitly supports retrieving response bodies and request POST data; it also exposes configurable buffering for preserving network payloads. ([Chrome DevTools][3])

For streaming/interception cases, the CDP `Fetch` domain can pause responses and expose the response as a stream through `Fetch.takeResponseBodyAsStream`. ([Chrome DevTools][4])

### But there's an important distinction

If by **FULL NETWORK LOG** you mean:

> every request as DevTools understands it, headers, request body, response, response body, initiator, timing, WebSockets, etc.

CDP is excellent.

If you mean:

> EVERYTHING going through Chromium's actual networking stack, DNS, sockets, proxies, TLS, HTTP/2/3, connection reuse, raw network events, possibly raw bytes

then **CDP alone isn't enough**.

Add **Chromium NetLog**.

Chromium describes NetLog as its network-stack event logging mechanism, and Chrome can start it automatically with:

```bash
--log-net-log=/path/to/netlog.json
```

and, when appropriate for your own trusted debugging environment:

```bash
--net-log-capture-mode=Everything
```

Chromium's documentation says the raw-byte capture mode can include the raw bytes transmitted over the network and warns that these captures can contain highly sensitive information. ([Chromium][5])

So I'd have **two network layers**:

```text
                 NETWORK OBSERVABILITY

        ┌────────────────────────────┐
        │        CDP Network         │
        │                            │
        │ URL                        │
        │ HTTP method                │
        │ headers                    │
        │ request payload            │
        │ response headers           │
        │ response body              │
        │ initiator                  │
        │ timings                    │
        │ WebSockets                 │
        │ service workers            │
        │ cache                      │
        └────────────┬───────────────┘
                     │
                     │ correlation
                     ▼
        ┌────────────────────────────┐
        │       Chromium NetLog      │
        │                            │
        │ DNS                        │
        │ sockets                    │
        │ connection attempts        │
        │ proxy resolution           │
        │ TLS/network stack          │
        │ protocol negotiation       │
        │ raw-byte diagnostics       │
        └────────────────────────────┘
```

That combination is extremely powerful.

One nuance: `Network.getRequestPostData()` explicitly notes that files from multipart request bodies can be omitted, so don't design your definition of “100% every byte” around that one CDP method alone. ([Chrome DevTools][3])

---

# Console access

Also easy.

Enable:

```text
Runtime.enable
Log.enable
```

Listen for:

```text
Runtime.consoleAPICalled
Runtime.exceptionThrown
```

`Runtime.consoleAPICalled` includes the call type, arguments, execution context, timestamp and stack trace information. ([Chrome DevTools][6])

Your MCP API could therefore provide things like:

```text
console.list(
    browser_id,
    page_id,
    level?,
    since?,
    search?
)

console.clear(...)

console.evaluate(...)
```

You could store logs indefinitely instead of losing them on navigation.

---

# HTML / DOM access

Not a problem.

CDP exposes the complete DOM domain.

You can retrieve a whole subtree with:

```text
DOM.getDocument
```

including traversal through frames/shadow roots when requested, retrieve markup through:

```text
DOM.getOuterHTML
```

and even modify it:

```text
DOM.setOuterHTML
DOM.setNodeValue
...
```

([Chrome DevTools][7])

And of course for many operations you can simply:

```ts
await page.evaluate(() => {
    document.querySelector(".thing")?.remove();
});
```

---

# CSS access

CDP has an actual **CSS domain**, which is much more interesting than merely doing `element.style.foo = ...`.

You can ask Chrome:

```text
CSS.getComputedStyleForNode
CSS.getInlineStylesForNode
CSS.getMatchedStylesForNode
CSS.getStyleSheetText
```

and modify things using:

```text
CSS.setStyleSheetText
CSS.setStyleTexts
CSS.setRuleSelector
...
```

So your agent can inspect the cascade and determine **which CSS rule actually caused something**, much like DevTools Elements → Styles. ([Chrome DevTools][8])

---

# JavaScript debugging

This is another reason I strongly favor raw CDP.

The `Debugger` domain gives you actual debugger functionality including breakpoints, conditional breakpoints, pause/resume, stepping, async stack tracking and script inspection. ([Chrome DevTools][9])

So you can expose:

```text
debugger.enable

debugger.scripts
debugger.get_source

debugger.breakpoint.add
debugger.breakpoint.remove

debugger.pause
debugger.resume

debugger.step_into
debugger.step_over
debugger.step_out

debugger.callframes
debugger.evaluate_on_frame

debugger.pause_on_exceptions
```

At that point your AI isn't merely "browsing."

It's essentially operating a programmable DevTools.

---

# Don't forget workers and iframes

This matters a lot.

A modern application can put code/network activity inside:

```text
main page
iframe
cross-origin iframe
dedicated worker
shared worker
service worker
extension service worker
other targets
```

If you just attach a CDP session to the top page, you'll miss things.

Use the CDP `Target` domain and automatic target attachment.

`Target.setAutoAttach` is specifically designed to attach to related targets such as iframes and workers, and Chromium notes that you may need to apply it recursively to auto-attached targets. ([Chrome DevTools][10])

I'd make a central:

```text
TargetManager
```

that discovers everything:

```text
browser
 ├─ page
 │   ├─ iframe
 │   ├─ iframe
 │   ├─ worker
 │   └─ worker
 │
 ├─ page
 │   └─ service worker
 │
 └─ extension service worker
```

Every target gets:

```text
Network.enable
Runtime.enable
Debugger.enable
```

as appropriate.

That is how you get much closer to your requirement of **“don't miss requests.”**

---

# Your extensions

Yes, your private debugging extensions can be part of the browser.

There is one 2026-specific wrinkle.

Chrome removed the traditional `--load-extension` command-line support from regular Google Chrome beginning with Chrome 137. ([Chrome for Developers][11])

But **Playwright's bundled Chromium** still supports the development workflow. Playwright's current documentation explicitly tells extension users to use its bundled Chromium because regular Google Chrome and Edge removed those sideloading command-line flags. ([Playwright][12])

Alternatively, Puppeteer now has first-class APIs:

```ts
const browser = await puppeteer.launch({
    headless: false,
    enableExtensions: [
        "/extensions/my-debug-extension"
    ]
});
```

and can install extensions dynamically with:

```ts
await browser.installExtension(path);
```

It can even obtain the MV3 extension service worker and execute code there. ([Puppeteer][13])

That's actually one reason **Puppeteer + CDP** may be slightly more attractive for your particular project than Playwright.

You could still use Playwright, though.

---

# Multiple browser instances + MCP

For this part, I would **not create one MCP server per browser** unless you have a particular reason.

Build one:

```text
browserd
```

daemon.

Every browser instance registers with `browserd`.

For example:

```json
{
  "browser_id": "br_7f201",
  "pid": 19382,
  "profile": "research",
  "cdp_endpoint": "ws://127.0.0.1:43117/...",
  "status": "ready",
  "started_at": "...",
  "extensions": [
    "my-debugger"
  ]
}
```

Then your MCP tools simply take:

```text
browser_id
```

as an argument.

For example:

```text
browser.list_instances()

browser.list_tabs({
    browser_id
})

network.list_requests({
    browser_id,
    page_id,
    url_pattern: "*graphql*"
})

network.get_request({
    browser_id,
    request_id
})
```

That's much cleaner than dynamically generating:

```text
browser_A_click
browser_B_click
browser_C_click
...
```

MCP is perfectly suitable for exposing this kind of tool API. The current July 28, 2026 MCP specification is stateless and specifically says stateful applications should use explicit server-minted handles passed as tool arguments — which maps nicely to `browser_id`, `page_id`, `request_id`, etc. ([Model Context Protocol][14])

For a local MCP HTTP server, bind it to:

```text
127.0.0.1
```

not:

```text
0.0.0.0
```

The current MCP Streamable HTTP security guidance specifically recommends localhost binding for local servers and requires Origin validation. ([Model Context Protocol][15])

---

# Discovery

You mentioned:

> multiple instances can discover and connect to multiple instances of the browser if it's running

I'd separate **MCP discovery** from **browser discovery**.

Have:

```text
AI
 ↓
one MCP endpoint
 ↓
browserd
 ↓
local browser registry
```

Browser instances could register through a Unix socket:

```text
~/.agent-browser/browserd.sock
```

or a localhost HTTP endpoint.

Something like:

```text
POST /instances/register
POST /instances/:id/heartbeat
DELETE /instances/:id
```

Then:

```text
browser.list_instances
```

queries this registry.

Browser processes can choose port `0`, receive a dynamically allocated CDP port, and register it.

This avoids making your AI discover arbitrary MCP ports.

---

# MCP tools I would expose

I would keep the model-facing interface relatively small and let your server do the complicated CDP operations internally:

```text
browser.*
page.*
dom.*
css.*
console.*
network.*
debugger.*
storage.*
extension.*
trace.*
```

For example:

```text
browser.list_instances
browser.launch
browser.close

page.list
page.activate
page.navigate
page.snapshot
page.screenshot
page.click
page.type
page.evaluate

dom.query
dom.inspect
dom.get_html
dom.modify

css.inspect
css.computed
css.matched_rules
css.modify

console.list
console.exceptions

network.list
network.inspect
network.request_body
network.response_body
network.websocket_messages
network.export

debugger.scripts
debugger.source
debugger.set_breakpoint
debugger.pause
debugger.resume
debugger.step

extension.list
extension.inspect

trace.start
trace.stop
```

And then one **power-user escape hatch**:

```text
cdp.send({
    browser_id,
    target_id,
    method,
    params
})
```

Example:

```json
{
  "browser_id": "br_123",
  "target_id": "page_456",
  "method": "Network.getResponseBody",
  "params": {
    "requestId": "8912.63"
  }
}
```

That escape hatch means if Chrome adds some obscure DevTools capability later, **you don't have to redesign your MCP API before the agent can use it.**

---

# One thing I would change from your original concept

Don't think:

```text
AI
 ↕
MCP
 ↕
custom browser driver
 ↕
Chrome
```

Think:

```text
                       YOUR PRODUCT

             ┌─────────────────────────┐
             │      Browser Daemon     │
             │                         │
             │ process management      │
             │ profile management      │
             │ target registry         │
             │ event database          │
             │ permissions             │
             │ CDP multiplexing        │
             │ network recorder        │
             └───────────┬─────────────┘
                         │
                ┌────────┴─────────┐
                │                  │
           Playwright/CDP       MCP Adapter
                │                  │
                ▼                  ▼
             Chromium             AI
```

**The browser daemon is the important software.**

MCP should merely be one interface onto that daemon.

That way, later you can add:

```text
CLI
REST API
WebSocket API
desktop UI
VS Code extension
MCP
```

without coupling browser management to MCP.

---

## What I would build for V1

My recommended stack would be **Node.js + TypeScript + Playwright's bundled Chromium + raw CDP + SQLite + MCP**. Playwright gives you excellent interaction primitives and raw CDP access; its bundled Chromium also avoids the current Chrome extension-loading limitation. ([Playwright][12])

If loading/managing your own extensions programmatically is a first-class feature from day one, I'd seriously consider **Puppeteer 25.x + raw CDP** instead, because Puppeteer's current extension APIs directly support loading, installing, listing and interacting with extension contexts. ([Puppeteer][13])

Most importantly, I would make **network recording run continuously inside `browserd`**, independent of the AI. Don't make the LLM subscribe fast enough to catch things. `browserd` should capture every CDP event, correlate it by `requestId`, persist bodies/metadata locally, and let the AI query the resulting database afterward.

That gives you the thing you're actually aiming for:

**a normal browser you can use yourself + an AI-controllable browser + basically programmatic DevTools + persistent complete request inspection + debugger access + custom extensions + multiple discoverable browser instances.**

And yes — that is substantially more capable than trying to cram the entire system into a browser extension.

[1]: https://playwright.dev/docs/api/class-browsertype "BrowserType | Playwright"
[2]: https://playwright.dev/docs/api/class-browsertype?utm_source=chatgpt.com "BrowserType"
[3]: https://chromedevtools.github.io/devtools-protocol/tot/Network/ "Chrome DevTools Protocol - Network domain"
[4]: https://chromedevtools.github.io/devtools-protocol/tot/Fetch/?utm_source=chatgpt.com "Fetch domain - Chrome DevTools Protocol"
[5]: https://www.chromium.org/for-testers/providing-network-details/?utm_source=chatgpt.com "How to capture a NetLog dump"
[6]: https://chromedevtools.github.io/devtools-protocol/tot/Runtime/?utm_source=chatgpt.com "Chrome DevTools Protocol - Runtime domain"
[7]: https://chromedevtools.github.io/devtools-protocol/tot/DOM/?utm_source=chatgpt.com "DOM domain - Chrome DevTools Protocol"
[8]: https://chromedevtools.github.io/devtools-protocol/tot/CSS/?utm_source=chatgpt.com "Chrome DevTools Protocol - CSS domain"
[9]: https://chromedevtools.github.io/devtools-protocol/tot/Debugger/?utm_source=chatgpt.com "Debugger domain - Chrome DevTools Protocol"
[10]: https://chromedevtools.github.io/devtools-protocol/tot/Target/?utm_source=chatgpt.com "Target domain - Chrome DevTools Protocol"
[11]: https://developer.chrome.com/blog/extension-news-june-2025 "What's happening in Chrome Extensions, June 2025  |  Blog  |  Chrome for Developers"
[12]: https://playwright.dev/docs/chrome-extensions?utm_source=chatgpt.com "Chrome extensions"
[13]: https://pptr.dev/guides/chrome-extensions?utm_source=chatgpt.com "Chrome Extensions"
[14]: https://modelcontextprotocol.io/specification/2026-07-28/changelog?utm_source=chatgpt.com "Key Changes"
[15]: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http?utm_source=chatgpt.com "Streamable HTTP"


The simplest mental model is: **MCP is the AI-facing RPC layer; CDP is the browser-facing RPC/event layer.** Your `browserd` process sits between them and translates one into the other.

```text
┌─────────────────┐
│   User / AI     │
└────────┬────────┘
         │
         │ tool decision
         ▼
┌─────────────────┐
│ MCP Host/Client │
│ Claude / IDE /  │
│ your agent app  │
└────────┬────────┘
         │
         │ MCP
         │ JSON-RPC
         │ stdio OR HTTP
         ▼
┌──────────────────────────────────────┐
│              browserd                │
│                                      │
│  MCP Server                          │
│       │                              │
│       ▼                              │
│  Browser Manager                     │
│       │                              │
│       ├── Network database           │
│       ├── Console database           │
│       ├── Target registry            │
│       │                              │
│       ▼                              │
│  Playwright / CDP Client             │
└───────────────┬──────────────────────┘
                │
                │ persistent WebSocket
                │ Chrome DevTools Protocol
                ▼
┌──────────────────────────────────────┐
│              Chromium                │
│                                      │
│ Browser                              │
│ ├─ Tab                               │
│ ├─ Tab                               │
│ ├─ iframe                            │
│ ├─ worker                            │
│ └─ service worker                    │
└──────────────────────────────────────┘
```

The current MCP specification uses JSON-RPC 2.0 for its data layer, while CDP exposes Chromium debugging through its own protocol connection, normally over a WebSocket. ([Model Context Protocol][1])

## 1. Browser startup and the first connection

Suppose your daemon starts Chromium:

```bash
chromium \
  --remote-debugging-port=0 \
  --user-data-dir=/home/me/agent-profiles/browser-001
```

`0` means:

> Chrome, pick an available port yourself.

When Chrome starts this way, it exposes its browser-level debugging WebSocket. Chrome writes the chosen debugging information into the browser profile's `DevToolsActivePort` file, and `/json/version` exposes the `webSocketDebuggerUrl`. ([Chrome DevTools][2])

Conceptually you'll get:

```text
Browser process:
PID = 48291

DevTools port:
41763

WebSocket:
ws://127.0.0.1:41763/devtools/browser/7fd36d...
```

Your daemon now establishes a **persistent WebSocket**:

```text
browserd ==================================> Chromium
         WebSocket stays connected
```

It does **not** open a new connection for every click/request.

That WebSocket remains alive for the browser's lifetime.

---

# 2. CDP itself is request/response + asynchronous events

This is probably the most important concept.

Over the WebSocket your daemon can send a command such as:

```json
{
  "id": 17,
  "method": "Network.enable",
  "params": {},
  "sessionId": "ABCD1234"
}
```

Chrome eventually responds:

```json
{
  "id": 17,
  "result": {},
  "sessionId": "ABCD1234"
}
```

The `id` lets your daemon match:

```text
request 17
       ↓
response 17
```

But Chrome can also send messages **without you asking**.

For example:

```json
{
  "method": "Network.requestWillBeSent",
  "params": {
    "requestId": "82931.42",
    "request": {
      "url": "https://example.com/api/orders",
      "method": "POST"
    }
  },
  "sessionId": "ABCD1234"
}
```

Then:

```json
{
  "method": "Network.responseReceived",
  "params": {
    "requestId": "82931.42",
    "response": {
      "status": 200
    }
  },
  "sessionId": "ABCD1234"
}
```

These are **events**.

Playwright exposes exactly these two raw-CDP concepts: `session.send()` for protocol commands and `session.on()` for protocol events. Its current API can even subscribe to every CDP event received by a session. ([Playwright][3])

Therefore your daemon is fundamentally an event-driven program.

---

# 3. One browser WebSocket can represent many tabs

This is another important part.

You don't need:

```text
tab 1 → separate daemon
tab 2 → separate daemon
tab 3 → separate daemon
```

Chromium has the concept of **targets**.

A target might correspond to a:

```text
browser
page
iframe
worker
service worker
extension worker
...
```

The CDP `Target` domain exists specifically for target discovery and attachment. ([Chrome DevTools][4])

Imagine:

```text
Chromium Browser
│
├── Target A
│   https://google.com
│
├── Target B
│   https://localhost:3000
│
│   ├── Worker C
│   └── iframe D
│
└── Target E
    chrome-extension://...
```

Your browser daemon discovers them:

```text
Target.getTargets
```

or continuously watches:

```text
Target.setDiscoverTargets
```

Chrome then emits events when targets appear/disappear:

```text
Target.targetCreated
Target.targetInfoChanged
Target.targetDestroyed
```

Those mechanisms are part of the current CDP Target domain. ([Chrome DevTools][4])

---

# 4. `sessionId` is how CDP multiplexes those targets

Suppose these exist:

```text
Target A = tab Google
Target B = localhost
Target C = worker
```

Your daemon attaches to Target B:

```text
Target.attachToTarget
targetId = B
flatten = true
```

Chrome returns:

```text
sessionId = "S-LOCALHOST"
```

CDP's flat session mode lets subsequent commands specify a `sessionId`; the protocol describes this specifically as a way of accessing attached target sessions. ([Chrome DevTools][4])

So:

```json
{
  "id": 70,
  "sessionId": "S-LOCALHOST",
  "method": "Runtime.evaluate",
  "params": {
    "expression": "document.title"
  }
}
```

means:

> Run this in **this specific target**.

While:

```json
{
  "id": 71,
  "sessionId": "S-WORKER",
  "method": "Runtime.evaluate",
  "params": {
    "expression": "self.location.href"
  }
}
```

is going somewhere else.

So internally your daemon maintains something like:

```text
browser_id: br_01

targets:
-----------------------------------------------------
target_id       session_id       type
-----------------------------------------------------
T-A             S-A              page
T-B             S-B              page
T-C             S-C              worker
T-D             S-D              iframe
T-E             S-E              service_worker
```

This is an important registry.

---

# 5. Auto-attaching to workers/iframes

You don't want the agent to miss:

```text
page creates worker
worker sends HTTP request
worker disappears
```

So you tell Chromium:

```text
Target.setAutoAttach
```

with roughly:

```text
autoAttach = true
flatten = true
```

CDP specifically says auto-attach handles related targets such as iframes and workers, attaches existing related targets, and may need to be applied recursively to auto-attached targets to cover all available targets. ([Chrome DevTools][4])

Then Chrome spontaneously tells your daemon:

```text
NEW WORKER!
```

Your daemon gets its `sessionId`, enables instrumentation:

```text
Network.enable
Runtime.enable
Log.enable
Debugger.enable
...
```

and starts collecting.

---

# 6. Network monitoring is PUSHED from Chrome to your daemon

This is a distinction worth emphasizing.

You **do not want the AI repeatedly asking**:

```text
anything new?
anything new?
anything new?
```

Instead:

```text
                 Network request happens

website ──────────────────────────────────► Internet
                        │
                        │ Chrome sees it
                        ▼
                   CDP event
                        │
                        ▼
                     browserd
                        │
                        ▼
                      SQLite
```

For example Chrome sends:

```text
Network.requestWillBeSent
Network.requestWillBeSentExtraInfo

Network.responseReceived
Network.responseReceivedExtraInfo

Network.dataReceived

Network.loadingFinished
```

The Network domain is specifically designed for tracking HTTP/file/data requests and responses and exposes headers, bodies, timing and other network information. ([Chrome DevTools][5])

Your collector does something like:

```ts
cdp.on("Network.requestWillBeSent", event => {
    networkStore.upsert({
        requestId: event.requestId,
        url: event.request.url,
        method: event.request.method,
        headers: event.request.headers,
        postData: event.request.postData
    });
});
```

Then later:

```ts
cdp.on("Network.responseReceived", event => {
    networkStore.update(event.requestId, {
        status: event.response.status,
        responseHeaders: event.response.headers,
        mimeType: event.response.mimeType
    });
});
```

And once finished:

```ts
const body = await cdp.send(
    "Network.getResponseBody",
    {
        requestId
    }
);
```

`Network.getRequestPostData` and `Network.getResponseBody` are current CDP methods specifically provided for retrieving request POST data and response bodies. ([Chrome DevTools][5])

Therefore **browserd records traffic whether the AI is looking at it or not.**

That's essential.

---

# 7. Now MCP sits ABOVE that system

MCP doesn't need to understand CDP.

Your MCP server exposes something nice like:

```text
network.list_requests
```

instead of exposing:

```text
Network.requestWillBeSent
Network.responseReceived
Target.attachToTarget
...
```

The AI sees:

```json
{
  "name": "network.list_requests",
  "description": "List network requests captured from a browser",
  "inputSchema": {
    "type": "object",
    "properties": {
      "browser_id": {
        "type": "string"
      },
      "target_id": {
        "type": "string"
      },
      "url_contains": {
        "type": "string"
      }
    },
    "required": ["browser_id"]
  }
}
```

MCP clients discover server capabilities and tools and invoke them via JSON-RPC. The current protocol defines tool discovery/execution in exactly this general manner. ([Model Context Protocol][1])

---

# 8. AI → MCP communication

There are currently two standard MCP transport options particularly relevant here:

```text
STDIO
```

or:

```text
Streamable HTTP
```

The 2026-07-28 MCP specification defines stdio as newline-delimited messages over a subprocess's standard streams, while Streamable HTTP sends messages by HTTP POST and can return JSON or a request-scoped SSE stream. MCP messages themselves use UTF-8 JSON-RPC. ([Model Context Protocol][6])

### Local implementation

You could configure the AI host to execute:

```text
node browserd.js --mcp
```

Then:

```text
AI application's MCP client

stdin  ──────────────────► browserd
stdout ◄────────────────── browserd
```

Very simple.

No TCP port required.

---

# 9. Or run browserd permanently over HTTP

For your use case I actually prefer this:

```text
browserd
listening:
127.0.0.1:7331/mcp
```

Then multiple clients can connect:

```text
Claude ──────────┐
                 │
VS Code ─────────┼──► localhost:7331/mcp
                 │
Your agent ──────┘
                        │
                        ▼
                     browserd
```

MCP's Streamable HTTP transport sends each message as an HTTP POST to an MCP endpoint; the server may answer with JSON or a request-scoped SSE stream. ([Model Context Protocol][6])

So communication might look conceptually like:

```http
POST /mcp
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 91,
  "method": "tools/call",
  "params": {
    "name": "network.list_requests",
    "arguments": {
      "browser_id": "br_01"
    }
  }
}
```

Then browserd returns:

```json
{
  "jsonrpc": "2.0",
  "id": 91,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "..."
      }
    ]
  }
}
```

The MCP layer has therefore **zero knowledge of WebSockets/CDP unless you deliberately expose it.**

---

# 10. One actual complete flow

Suppose you tell the AI:

> Find the request being made when I press Login and show me its payload and response.

The communication is:

```text
YOU
 │
 │ "find login request"
 ▼
AI
 │
 │ chooses network.list_requests
 ▼
MCP CLIENT
 │
 │ JSON-RPC
 │ tools/call
 ▼
BROWSERD MCP SERVER
 │
 │ calls internal function
 ▼
NetworkStore
 │
 │ SQL query
 ▼
SQLite
```

Response:

```text
SQLite
  │
  │ captured request objects
  ▼
browserd
  │
  │ MCP JSON result
  ▼
MCP client
  │
  ▼
AI
```

Notice something important:

### Chrome wasn't even involved in that lookup.

Because the request was already captured.

That makes the architecture much better.

---

# 11. For something live, the flow goes all the way to Chrome

Suppose AI says:

> Click the submit button.

Then:

```text
AI
 │
 │ tool call:
 │ page.click(...)
 ▼
MCP
 │
 ▼
browserd
 │
 ▼
Playwright
 │
 ▼
CDP
 │
 ▼
Chromium
 │
 ▼
physical page changes
```

Playwright can attach to an existing Chromium instance via `connectOverCDP()`, and Playwright's `CDPSession` API provides raw CDP command/event access. ([Playwright][7])

Internally you could use:

```ts
await page.locator("#submit").click();
```

You generally don't need the AI to know how Playwright implemented the interaction.

---

# 12. But for debugger commands, go directly through CDP

AI:

> Put a breakpoint on `auth.js:219`.

Flow:

```text
AI
  │
  │ debugger.set_breakpoint(...)
  ▼
MCP
  │
  ▼
browserd
  │
  │ translate
  ▼
CDP
```

Something equivalent to:

```json
{
  "id": 882,
  "sessionId": "S-LOCALHOST",
  "method": "Debugger.setBreakpointByUrl",
  "params": {
    "url": "https://localhost:3000/auth.js",
    "lineNumber": 218
  }
}
```

Then Chrome responds:

```text
CDP result
   ↓
browserd
   ↓
MCP result
   ↓
AI
```

---

# 13. Some communications are completely asynchronous

Suppose your browser is sitting open and **you manually click something**.

The AI did absolutely nothing.

Still:

```text
YOU click button
       │
       ▼
     Chrome
       │
       ├── Runtime.consoleAPICalled
       ├── Network.requestWillBeSent
       ├── Network.responseReceived
       └── Page.*
                 │
                 ▼
              browserd
                 │
              captures
                 │
                 ▼
                DB
```

This is why the system supports:

> I use the browser normally, but the AI can inspect what happened afterward.

The connection is observational as well as controllable.

---

# 14. Multiple browser instances

Now imagine:

```text
Browser #1
CDP websocket A

Browser #2
CDP websocket B

Browser #3
CDP websocket C
```

`browserd` owns three persistent connections:

```text
browserd
 │
 ├──────── WS ──────► Chromium A
 │
 ├──────── WS ──────► Chromium B
 │
 └──────── WS ──────► Chromium C
```

Internally:

```ts
class BrowserRegistry {
    browsers = new Map<string, BrowserConnection>();
}
```

Something like:

```text
br_01 → ws://127.0.0.1:41001/devtools/browser/...
br_02 → ws://127.0.0.1:41002/devtools/browser/...
br_03 → ws://127.0.0.1:41003/devtools/browser/...
```

The MCP server then exposes:

```text
browser.list
```

returning:

```json
[
  {
    "browser_id": "br_01",
    "profile": "personal-debug",
    "tabs": 4
  },
  {
    "browser_id": "br_02",
    "profile": "test-user",
    "tabs": 2
  },
  {
    "browser_id": "br_03",
    "profile": "staging",
    "tabs": 7
  }
]
```

And every call specifies the browser:

```text
network.list_requests(
    browser_id = "br_02"
)
```

The current MCP specification moved away from protocol-level session state; applications that need persistent state are intended to use explicit server-generated handles as ordinary arguments. `browser_id`, `target_id`, and `request_id` are therefore a particularly natural design. ([Model Context Protocol][8])

---

# 15. You probably don't need browsers to "find the MCP"

I'd reverse it.

Don't do:

```text
Browser
  ↓
search network
  ↓
find an MCP server
  ↓
register
```

Instead have **browserd launch the browsers**.

```text
browserd
 │
 ├─ spawn Browser A
 │
 ├─ spawn Browser B
 │
 └─ spawn Browser C
```

Now browserd already knows:

```text
PID
profile
debug port
CDP URL
browser_id
```

No discovery required.

For browsers launched independently, you can add:

```text
browser-agent
     │
     └── Unix socket
              │
              ▼
          browserd
```

and register:

```json
{
  "type": "REGISTER_BROWSER",
  "pid": 47291,
  "cdpUrl": "ws://127.0.0.1:41822/devtools/browser/...",
  "profile": "/profiles/foo"
}
```

But I'd make that an optional feature.

---

# 16. The three identifiers you should keep separate

This will save you enormous pain.

Don't call everything `pageId`.

Use:

```text
browser_id
```

Your identifier:

```text
br_8df2
```

Then:

```text
target_id
```

Chromium's target identifier.

Then:

```text
session_id
```

Chromium's attached debugging session.

And independently:

```text
request_id
```

CDP Network request ID.

For example:

```text
Browser
br_001
   │
   └── Target
       78AD92...
          │
          └── CDP Session
              83CC11...
                 │
                 ├── Request
                 │   10822.54
                 │
                 └── Request
                     10822.55
```

Store those relationships.

---

# 17. I would add your own durable IDs as well

Because CDP IDs belong to a browser execution.

Make:

```text
browser_id = br_01

target_handle = tgt_192
cdp_target_id = C340E99....

network_handle = req_88192
cdp_request_id = 33921.92
```

Then MCP returns:

```json
{
  "request_id": "req_88192"
}
```

AI later calls:

```text
network.inspect("req_88192")
```

instead of forcing the LLM to carry Chrome-internal identifiers around.

---

# 18. Separate your "live control" and "historical data" paths

This is perhaps the architectural choice I'd emphasize most.

### Live path

```text
AI
 ↓
MCP
 ↓
browserd
 ↓
CDP / Playwright
 ↓
Chrome
```

Used for:

```text
click
navigate
type
evaluate JS
modify DOM
breakpoint
pause
resume
take screenshot
```

### Recording path

```text
Chrome
 ↓
CDP event stream
 ↓
browserd collectors
 ↓
SQLite / blobs
```

Used for:

```text
network traffic
console
exceptions
target history
WebSocket frames
navigation history
performance events
```

### Query path

```text
AI
 ↓
MCP
 ↓
browserd
 ↓
SQLite
```

Used for:

```text
show last 20 network requests
find GraphQL call
show response from request X
search console errors
```

That's far more efficient than constantly interrogating Chrome.

---

# 19. And there's one very useful escape hatch

Expose:

```text
cdp.send
```

to advanced agents.

For example:

```text
cdp.send(
    browser_id = "br_01",
    target_id = "tgt_23",
    method = "Network.getResponseBody",
    params = {
        requestId: "18292.76"
    }
)
```

Internally:

```text
MCP
 │
 ▼
resolve tgt_23
 │
 ▼
find sessionId
 │
 ▼
send CDP command
 │
 ▼
await matching CDP response ID
 │
 ▼
return result
```

So your normal API can remain pleasant:

```text
page.click
network.inspect
console.search
debugger.breakpoint
```

while the agent still has a way of accessing obscure Chrome debugging capabilities.

---

## Ultimately there are **three protocols**, not one

```text
                       USER
                        │
                        ▼
                   ┌─────────┐
                   │   AI    │
                   └────┬────┘
                        │
                tool-call decision
                        │
                        ▼

══════════════════ MCP BOUNDARY ═══════════════════

                  JSON-RPC / MCP
                stdio or HTTP/SSE
                        │
                        ▼
                ┌───────────────┐
                │   browserd    │
                │               │
                │ MCP adapter   │
                │      ↓        │
                │ browser core  │
                └───────┬───────┘
                        │

══════════════════ CDP BOUNDARY ═══════════════════

               WebSocket + CDP
        commands ◄────────────► events
                        │
                        ▼
                 ┌────────────┐
                 │  Chromium  │
                 └──────┬─────┘
                        │

══════════════════ WEB BOUNDARY ═══════════════════

                  HTTP / HTTPS
              WebSocket / HTTP3 etc.
                        │
                        ▼
                    INTERNET
```

So **MCP never talks directly to websites**, and the **AI never needs to talk directly to CDP**.

Your daemon is the translator/state holder:

```text
AI vocabulary:

"show me the response for the login request"


          ↓ browserd translates ↓


CDP vocabulary:

Target/session resolution
Network.getResponseBody
requestId=...
```

And the most important implementation detail is that **CDP should remain continuously connected and continuously recording even when no AI request is occurring**. That is what turns the project from “browser automation exposed over MCP” into the programmable, AI-accessible DevTools environment you actually described. ([Playwright][3])

[1]: https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture "Architecture overview - Model Context Protocol"
[2]: https://chromedevtools.github.io/devtools-protocol/ "Chrome DevTools Protocol"
[3]: https://playwright.dev/docs/api/class-cdpsession "CDPSession | Playwright"
[4]: https://chromedevtools.github.io/devtools-protocol/tot/Target "Chrome DevTools Protocol - Target domain"
[5]: https://chromedevtools.github.io/devtools-protocol/tot/Network/ "Chrome DevTools Protocol - Network domain"
[6]: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports "Overview - Model Context Protocol"
[7]: https://playwright.dev/docs/api/class-browsertype?utm_source=chatgpt.com "BrowserType"
[8]: https://modelcontextprotocol.io/specification/2026-07-28/changelog?utm_source=chatgpt.com "Key Changes"

Yes — **verified against the current Playwright and Chrome DevTools Protocol docs**. What you want is technically achievable.

But I would define the goal slightly more precisely:

> Build an AI-controlled browser that combines **human-style visual browser automation + DOM/JS/CSS inspection + DevTools console + full network recording + debugger access + persistent/exportable diagnostic artifacts**.

That is much more than a normal Playwright MCP server.

### The agent can actually “see” the page

For every tab, your daemon can capture the current rendered viewport or the entire scrollable page. Playwright supports both normal screenshots and full-page screenshots, and CDP itself exposes `Page.captureScreenshot`. ([Playwright][1])

So the AI can do:

```text
browser.tabs()

→ tab_12
  https://localhost:3000/dashboard

page.screenshot(tab_12)

→ image/png
```

If the AI model has vision and its MCP/client layer supports passing the screenshot as image content, it can **visually inspect the rendered page**.

Then it can reason:

```text
"The Save button is partially hidden behind the modal."
```

and act:

```text
page.click(...)
page.scroll(...)
page.hover(...)
page.type(...)
page.press(...)
```

Playwright explicitly supports precise mouse-wheel scrolling, including scrolling containers independently. ([Playwright][2])

There is one distinction: this screenshot is normally of the **web page**, not the Chrome tab strip/address bar/browser chrome. If you eventually want the AI literally manipulating Chrome's address bar, extension toolbar, native dialogs, etc., I would add an optional OS-level UI automation layer. For normal websites, tabs, page content and debugging, you don't need that.

---

# The agent should have TWO ways to understand a page

This is critical.

Don't make it choose between:

```text
vision
OR
HTML
```

Give it both:

```text
                 TAB

          ┌───────┴───────┐
          │               │
       VISUAL          STRUCTURAL
          │               │
     screenshot           DOM
     viewport             HTML
     full-page            CSS
                          accessibility
                          JS state
```

Suppose visually something is wrong:

```text
AI looks at screenshot:

"The dropdown appears underneath the dialog."
```

Then it can inspect the element:

```text
dom.inspect("#country-menu")
```

returning something like:

```json
{
  "tag": "div",
  "id": "country-menu",
  "classes": ["menu", "floating"],
  "outerHTML": "...",
  "boundingBox": {
    "x": 544,
    "y": 391,
    "width": 380,
    "height": 420
  }
}
```

CDP can directly retrieve a node's outer HTML, including optional shadow DOM information. ([Chrome DevTools][3])

Then:

```text
css.inspect("#country-menu")
```

could return:

```json
{
  "computed": {
    "position": "absolute",
    "z-index": "10",
    "overflow": "visible"
  },

  "matchedRules": [
    {
      "selector": ".floating",
      "file": "/src/menu.css",
      "line": 82,
      "properties": {
        "z-index": "10"
      }
    },

    {
      "selector": ".modal",
      "file": "/src/modal.css",
      "line": 26,
      "properties": {
        "z-index": "1000"
      }
    }
  ]
}
```

CDP's CSS domain exposes computed style, inline style, applicable rules from stylesheets and stylesheet source text. ([Chrome DevTools][4])

Now the AI can conclude:

```text
"The menu is visually behind the modal because
its stacking context has z-index 10 while the modal uses 1000."
```

That is exactly the kind of visual + source debugging you're talking about.

---

# And yes — highlight the thing the AI is inspecting

Absolutely add this.

Chrome already has a DevTools overlay mechanism:

```text
Overlay.highlightNode
```

which can highlight a DOM node or selector directly inside the page. ([Chrome DevTools][5])

So expose:

```text
page.highlight({
    selector: "#submit-button"
})
```

Then your browser visibly shows:

```text
┌──────────────────────────────┐
│                              │
│        Login form            │
│                              │
│   ┌──────────────────────┐   │
│   │      SUBMIT          │   │   ← highlighted
│   └──────────────────────┘   │
│                              │
└──────────────────────────────┘
```

This is useful for both **you** and the **AI**.

The agent can:

```text
1. find element
2. highlight element
3. screenshot
4. visually verify that it found the correct thing
```

That's a great debugging workflow.

---

# Console: yes, continuously record it

Not merely:

```text
get current console
```

Instead browserd should permanently subscribe.

CDP emits `Runtime.consoleAPICalled` whenever a page uses the console API and also has exception events. ([Chrome DevTools][6])

Playwright likewise exposes console events and gives access to the actual arguments passed to `console.log`. ([Playwright][7])

I'd store:

```text
timestamp
browser_id
tab_id
frame_id
execution_context
level
message
arguments
source_url
line
column
stack_trace
```

Then the AI can do:

```text
console.query({
    tab_id: "tab_12",
    level: ["error", "warning"],
    since: "2026-08-17T16:40:00+05:30"
})
```

or:

```text
console.query({
    tab_id: "tab_12",
    start_time: "...",
    end_time: "...",
    contains: "authentication",
    offset: 0,
    limit: 100
})
```

That's exactly how I would handle your **large-log problem**.

Don't shove 50,000 lines into the LLM context.

---

# Executing things like the DevTools console

Yes.

If what you mean is:

> The AI should be able to type JavaScript as though it typed something into DevTools Console.

That's exactly what `Runtime.evaluate` does.

CDP defines `Runtime.evaluate` as evaluating an expression on the target's global object and can enable the DevTools command-line API during evaluation. ([Chrome DevTools][6])

Playwright also has:

```ts
page.evaluate(...)
```

for executing JavaScript directly inside the page context. ([Playwright][7])

Your MCP command:

```text
console.execute({
    tab_id: "tab_12",

    expression: `
        document.querySelector('#user').value
    `
})
```

could return:

```json
{
    "type": "string",
    "value": "alice@example.com"
}
```

Or:

```text
console.execute({
    expression: `
        [...document.querySelectorAll('button')]
            .map(x => ({
                text: x.innerText,
                disabled: x.disabled
            }))
    `
})
```

That is much more powerful than simple text extraction.

---

# Now the network side

This should be treated as a **first-class subsystem**, not a Playwright afterthought.

Chrome's Network CDP domain explicitly exposes HTTP/file/data requests and responses, including headers, bodies and timing. It has methods for retrieving POST data and response bodies and events for ordinary requests, responses, WebSockets and more. ([Chrome DevTools][8])

Every request should become a durable record.

Something like:

```text
REQUEST req_74ae2

timestamp
tab
frame
worker
initiator

METHOD
POST

URL
https://api.example.com/v1/login

REQUEST HEADERS
...

COOKIES
...

REQUEST BODY
...

RESPONSE STATUS
401

RESPONSE HEADERS
...

RESPONSE BODY
...

TIMING
...

PROTOCOL
h2

REMOTE ADDRESS
...

CACHE
...

SERVICE WORKER
...

INITIATOR STACK
...
```

CDP specifically provides:

```text
Network.getRequestPostData
Network.getResponseBody
```

and response-body retrieval tells you whether the returned content is base64 encoded. Request POST retrieval has an important caveat: files in multipart uploads may be omitted from that method, so your recorder should not assume that particular call alone represents literally every byte of every possible upload. ([Chrome DevTools][8])

---

# Don't return enormous responses directly to the AI

You are exactly right about this.

Imagine a request returns:

```text
42 MB JSON
```

Doing:

```text
MCP result:
"here are 42MB of tokens"
```

would be ridiculous.

Instead your system should have an **artifact store**.

```text
browserd/
└── data/
    └── br_001/
        └── session_20260817_1642/
            ├── network.sqlite
            │
            ├── bodies/
            │   ├── req_001.request.bin
            │   ├── req_001.response.json
            │   ├── req_002.response.html
            │   └── ...
            │
            ├── console.ndjson
            │
            ├── dom/
            │   └── ...
            │
            └── screenshots/
                └── ...
```

Then:

```text
network.inspect("req_8238")
```

might return:

```json
{
  "method": "POST",
  "url": "https://api.example.com/graphql",
  "status": 200,

  "request_headers": {
    "...": "..."
  },

  "request_body": {
    "size": 48293,
    "preview": "{\"operationName\":\"GetUser\"...",
    "artifact": "artifact://network/req_8238/request"
  },

  "response_body": {
    "size": 18429932,
    "mime": "application/json",
    "artifact": "artifact://network/req_8238/response"
  }
}
```

That's the architecture I strongly recommend.

---

# Don't rely exclusively on filesystem paths

This is one thing I'd change from:

> just supply the path

Paths are useful:

```text
/workspace/browser-artifacts/req_123.response.json
```

but an arbitrary MCP client may not have filesystem access to the same machine.

Therefore support **both**:

```text
path:
"/workspace/browser-artifacts/req_123.response.json"

artifact_uri:
"browser-artifact://br_01/network/req_123/response"
```

Then expose:

```text
artifact.stat()
artifact.read()
artifact.read_range()
artifact.search()
artifact.export()
```

For example:

```text
artifact.read({
    artifact_id: "art_82",
    offset: 0,
    length: 65536
})
```

or:

```text
artifact.search({
    artifact_id: "art_82",
    query: "\"paymentStatus\""
})
```

That way a 200 MB JSON response is still usable.

The agent can inspect it incrementally.

---

# JSON-aware inspection would be even better

For JSON responses, don't make the model manually scan everything.

Have browserd parse it.

Then:

```text
network.response.json_query({
    request_id: "req_82",

    query:
      "$.data.users[?(@.status == 'disabled')]"
})
```

or something simpler:

```text
network.response.search({
    request_id: "req_82",
    contains: "payment_failed",
    context_lines: 10
})
```

For HTML:

```text
network.response.html_query(...)
```

For text:

```text
artifact.grep(...)
```

This makes the debugging agent dramatically more effective.

---

# HAR export too

Also support:

```text
network.export_har()
```

Playwright currently has native HAR recording options and supports a full recording mode; response/request resources can either be embedded or stored as separate attached resources. ([Playwright][9])

So you could support:

```text
network.export({
    format: "har",
    scope: "tab",
    tab_id: "tab_12"
})
```

alongside your own richer format:

```text
network.export({
    format: "jsonl",
    include: [
        "request_headers",
        "request_body",
        "response_headers",
        "response_body"
    ]
})
```

I would **not use HAR as your only internal database**, though.

Your own SQLite + blob storage should be the canonical store.

HAR is an export format.

---

# Console should work the same way

Instead of:

```text
console.get_all()
```

provide proper slicing.

```text
console.query({
    browser_id,
    tab_id,

    after: timestamp,
    before: timestamp,

    level: "error",

    search: "undefined",

    limit: 100,
    cursor: "..."
})
```

Output:

```text
29,421 matching records

showing 100

next_cursor = "..."
```

And:

```text
console.export({
    tab_id,
    after,
    before,
    format: "ndjson"
})
```

returns:

```text
artifact://console/export/89422
```

The same philosophy should apply everywhere:

```text
BIG DATA
     ↓
store locally
     ↓
query/index/filter
     ↓
small useful result
     ↓
LLM
```

---

# HTML should work the same way

You don't want:

```text
dom.get_entire_html()
```

every time.

Sometimes a page can be enormous.

Instead give the AI levels.

```text
dom.summary(tab)
```

could produce:

```text
body
├── header
│   ├── nav
│   └── button "Sign in"
│
├── main
│   ├── form#checkout
│   └── div#payment-widget
│
└── footer
```

Then:

```text
dom.query("#payment-widget")
```

Then:

```text
dom.outer_html(node)
```

Then, only when necessary:

```text
dom.export({
    root: node,
    include_shadow_dom: true
})
```

→

```text
artifact://dom/dump/1282
```

CDP directly supports document traversal, selectors, node information and retrieval of outer HTML. ([Chrome DevTools][3])

---

# Same for CSS

Imagine AI says:

> Why isn't this thing visible?

It should be able to request:

```text
css.explain_visibility("#checkout")
```

Your daemon can combine:

```text
computed style
matched styles
bounding box
ancestors
overflow
opacity
display
visibility
position
z-index
clip
transform
```

because CDP exposes computed CSS and all matched stylesheet rules. ([Chrome DevTools][4])

Then return:

```text
Element:
#checkout

display: block
visibility: visible
opacity: 1

Bounding box:
x=0 y=891 width=0 height=0

Potential problem:
parent .checkout-wrapper has width: 0

Source:
src/styles/checkout.css:182
```

That's much more valuable to an AI than giving it a 10,000-line stylesheet.

---

# JavaScript/source debugging should also be artifact-oriented

Eventually you'll want:

```text
js.scripts()
js.get_source()
js.search_source()
js.export_source()
```

Then the AI might say:

```text
Search all loaded JavaScript for:
"/api/payment"
```

Instead of sending 30 MB of minified JS into context, browserd searches locally and gives:

```text
3 matches:

webpack://src/api/payments.ts:84
webpack://src/hooks/useCheckout.ts:211
https://site.com/assets/app.f81d2.js:183992
```

Then AI opens only:

```text
js.source_range(
    script,
    line_start: 70,
    line_end: 110
)
```

This is the pattern I would use throughout the entire project.

---

# Screenshots should be queryable artifacts too

For example:

```text
page.screenshot({
    tab_id: "tab_12",
    mode: "viewport"
})
```

returns both:

```json
{
  "image": "<MCP image>",
  "artifact": "artifact://screenshots/ss_182.png"
}
```

The AI gets the actual image immediately.

But you also preserve it for debugging.

And:

```text
page.screenshot({
    mode: "full_page"
})
```

is supported by Playwright. ([Playwright][1])

---

# A debugging session could therefore look like this

You:

> The checkout isn't working. Figure it out.

Agent:

```text
browser.tabs()
```

Finds:

```text
tab_9
http://localhost:3000/checkout
```

Then:

```text
page.screenshot(tab_9)
```

AI visually sees:

```text
Payment failed
```

Then:

```text
console.query(
    tab_9,
    last = "5m",
    levels = ["error"]
)
```

Finds:

```text
TypeError:
Cannot read properties of undefined
at submitPayment (payment.ts:182)
```

Then:

```text
network.query({
   tab_id: tab_9,
   last: "5m",
   type: ["fetch", "xhr"]
})
```

Gets:

```text
POST /api/payment      400
POST /api/analytics    204
```

Agent:

```text
network.inspect(req_payment)
```

Gets:

```text
Request body:

{
   "cardToken": "...",
   "currency": "USD"
}

Response:

{
   "error": "missing field",
   "field": "amount"
}
```

Then:

```text
js.search_source("submitPayment")
```

Gets:

```text
src/payment.ts:164
```

Then:

```text
js.source_range(
   src/payment.ts,
   150,
   210
)
```

Finds:

```ts
fetch("/api/payment", {
    method: "POST",

    body: JSON.stringify({
       cardToken,
       currency
       // amount missing
    })
});
```

Then the agent can tell you:

> `amount` isn't included in the POST payload. The backend responds with `400 {"field":"amount"}`. The call originates in `src/payment.ts` around line 182.

**That is exactly the system you're describing.**

---

# The MCP surface I would actually implement

Rather than 300 tiny functions, I'd make a coherent set like this:

| Area         | Examples                                                             |
| ------------ | -------------------------------------------------------------------- |
| Browser      | `browser.list`, `browser.launch`, `browser.status`                   |
| Tabs         | `tabs.list`, `tabs.activate`, `tabs.close`                           |
| Vision       | `page.screenshot`, `page.screenshot_full`                            |
| Interaction  | `page.click`, `page.type`, `page.scroll`, `page.hover`, `page.press` |
| DOM          | `dom.query`, `dom.inspect`, `dom.html`, `dom.export`                 |
| Highlighting | `dom.highlight`, `dom.unhighlight`                                   |
| CSS          | `css.inspect`, `css.computed`, `css.rules`, `css.source`             |
| JS           | `js.evaluate`, `js.scripts`, `js.source`, `js.search`                |
| Console      | `console.query`, `console.follow`, `console.export`                  |
| Network      | `network.query`, `network.inspect`, `network.export`                 |
| Network body | `network.request_body`, `network.response_body`                      |
| WebSockets   | `websocket.list`, `websocket.frames`                                 |
| Debugger     | `debugger.breakpoint`, `pause`, `resume`, `step`                     |
| Artifacts    | `artifact.read`, `artifact.search`, `artifact.export`                |
| Escape hatch | `cdp.send`                                                           |

Behind those commands, Chrome is continuously producing events; the agent only requests the relevant slices. Chrome's network subsystem supports request/response events, WebSocket frame events and configurable payload buffering, which fits this recorder model well. ([Chrome DevTools][8])

---

## So yes: your target architecture makes sense

What you're building is **not merely an AI browser**.

It is closer to:

```text
                 AI BROWSER WORKBENCH

                    ┌───────────┐
                    │  Vision   │
                    │ screenshots│
                    └─────┬─────┘
                          │
 ┌─────────────┐          │          ┌─────────────┐
 │ Interaction │──────────┼──────────│    DOM      │
 │ click/type  │          │          │ HTML/CSS    │
 │ scroll      │          │          │ highlight   │
 └─────────────┘          │          └─────────────┘
                          │
                    ┌─────▼─────┐
                    │    AI     │
                    └─────┬─────┘
                          │
 ┌─────────────┐          │          ┌─────────────┐
 │   Console   │──────────┼──────────│  Debugger   │
 │ logs/errors │          │          │ source/bps  │
 │ JS evaluate │          │          │ stack/frame │
 └─────────────┘          │          └─────────────┘
                          │
                    ┌─────▼──────┐
                    │  NETWORK   │
                    │            │
                    │ requests   │
                    │ headers    │
                    │ payloads   │
                    │ responses  │
                    │ websocket  │
                    └─────┬──────┘
                          │
                          ▼
                  ┌───────────────┐
                  │ ARTIFACT STORE│
                  │               │
                  │ SQLite indexes│
                  │ JSON / NDJSON │
                  │ bodies        │
                  │ screenshots   │
                  │ HAR exports   │
                  │ DOM snapshots │
                  │ source files  │
                  └───────────────┘
```

The part I would be most adamant about is this: **record first, query later**.

Network events, console logs, exceptions and target events should be collected continuously by `browserd`, whether or not the AI is currently asking about them. The AI then works with time ranges, filters, cursors, searches, structured JSON queries, artifact IDs and file exports.

That gets you much closer to **“an AI developer sitting in front of Chrome + DevTools”** rather than just “Playwright controlled by an LLM.”

[1]: https://playwright.dev/docs/screenshots "Screenshots | Playwright"
[2]: https://playwright.dev/docs/input "Actions | Playwright"
[3]: https://chromedevtools.github.io/devtools-protocol/tot/DOM/ "Chrome DevTools Protocol - DOM domain"
[4]: https://chromedevtools.github.io/devtools-protocol/tot/CSS/ "Chrome DevTools Protocol - CSS domain"
[5]: https://chromedevtools.github.io/devtools-protocol/tot/Overlay/ "Chrome DevTools Protocol - Overlay domain"
[6]: https://chromedevtools.github.io/devtools-protocol/tot/Runtime/ "Chrome DevTools Protocol - Runtime domain"
[7]: https://playwright.dev/docs/api/class-page "Page | Playwright"
[8]: https://chromedevtools.github.io/devtools-protocol/tot/Network/ "Chrome DevTools Protocol - Network domain"
[9]: https://playwright.dev/docs/api/class-browser "Browser | Playwright"

Yes. **This is exactly where I’d expand `browserd` into a full DevTools/debugging backend.** Chrome already exposes most of these capabilities through CDP; the trick is wrapping them in AI-friendly tools and storing large outputs as artifacts rather than dumping everything into model context.

The architecture becomes:

```text
                         AI
                          │
                          │ MCP
                          ▼
┌──────────────────────────────────────────────────┐
│                    browserd                      │
│                                                  │
│  page      network      console      inspector   │
│  storage   debugger     memory       profiler    │
│  tracing   artifacts    processes    cdp.raw     │
│                                                  │
└────────────────────────┬─────────────────────────┘
                         │ CDP
                         ▼
               Chromium / DevTools
```

## Storage should absolutely be first-class

For `localStorage` and `sessionStorage`, CDP already has the `DOMStorage` domain. It can list, set, remove and clear entries, and its storage identifier explicitly distinguishes local storage from session storage. ([Chrome DevTools][1])

So expose something pleasant like:

```text
storage.local.list(tab_id)
storage.local.get(tab_id, key)
storage.local.set(tab_id, key, value)
storage.local.delete(tab_id, key)
storage.local.clear(tab_id)

storage.session.list(tab_id)
storage.session.get(tab_id, key)
storage.session.set(tab_id, key, value)
storage.session.delete(tab_id, key)
storage.session.clear(tab_id)
```

The AI could therefore do:

```text
storage.session.list("tab_12")

→
auth_state = "expired"
checkout_step = "payment"
debug_mode = "false"
```

Then:

```text
storage.session.set(
    tab_id = "tab_12",
    key = "debug_mode",
    value = "true"
)
```

And reload the page.

Cookies should get their own tools too. CDP's `Storage` domain can retrieve browser cookies and set cookies, as well as clear origin/storage data and inspect usage/quota. ([Chrome DevTools][2])

```text
storage.cookies.list()
storage.cookies.set(...)
storage.cookies.delete(...)
storage.cookies.export(...)
```

---

## IndexedDB too

This is particularly useful with modern applications.

CDP can enumerate IndexedDB databases, describe their object stores, retrieve metadata, page through records, clear stores, delete ranges and delete databases. ([Chrome DevTools][3])

So:

```text
storage.indexeddb.databases(tab_id)

storage.indexeddb.describe(
    database = "app"
)

storage.indexeddb.query(
    database = "app",
    store = "users",
    limit = 100
)

storage.indexeddb.export(...)
```

One implementation detail: the current CDP IndexedDB domain has strong read/delete APIs but does **not** expose a general `put()` method. For arbitrary writes, your daemon can execute the regular IndexedDB JavaScript API inside the appropriate page execution context through `Runtime.evaluate`. ([Chrome DevTools][3])

Your MCP can hide that difference:

```text
storage.indexeddb.put(...)
```

and `browserd` decides whether CDP or page-side JS should implement it.

Same idea with Cache Storage: CDP can enumerate caches, inspect entries and retrieve cached response bodies; arbitrary cache mutations can fall back to executing the Cache API inside the page. ([Chrome DevTools][4])

---

# The debugger can be extremely powerful

This isn't fake debugging.

CDP's `Debugger` domain supports actual JavaScript debugging: breakpoints, pause/resume, stepping, call frames, source inspection, async stacks and pause-on-exception behavior. ([Chrome DevTools][5])

I'd expose:

```text
debugger.enable(tab)

debugger.scripts()
debugger.source(script)
debugger.search_source(...)

debugger.breakpoint.set(...)
debugger.breakpoint.remove(...)

debugger.pause()
debugger.resume()

debugger.step_over()
debugger.step_into()
debugger.step_out()

debugger.pause_on_exceptions("uncaught")

debugger.stack()
debugger.scopes()
debugger.variables()

debugger.evaluate(frame, expression)
debugger.set_variable(...)
```

The last one is important.

CDP actually supports `Debugger.setVariableValue`, allowing a variable in local/closure/catch scope on a paused call frame to be changed. ([Chrome DevTools][5])

So the AI could encounter:

```text
PAUSED

submitPayment()
payment.ts:182

locals:

amount = undefined
currency = "USD"
token = "tok_92..."
```

and ask:

```text
debugger.set_variable(
    frame = 0,
    variable = "amount",
    value = 4999
)
```

Then:

```text
debugger.resume()
```

That's very close to what a developer manually does in Sources.

---

## And it can inspect objects while paused

CDP `Runtime` exposes live JavaScript objects as remote object handles. You can retrieve their properties and invoke functions against those objects. ([Chrome DevTools][6])

So imagine:

```text
debugger.variables(frame_0)

cart → object obj_822
user → object obj_823
request → object obj_824
```

Then:

```text
runtime.properties("obj_822")
```

could show:

```text
items: Array(4)
subtotal: 2499
tax: 200
discount: undefined
```

And:

```text
runtime.evaluate_on_object(
    "obj_822",
    "function () { return this.items.map(x => x.price) }"
)
```

could inspect it further.

That is effectively **AI-accessible object inspection**.

---

# One current limitation worth knowing

Don't build around editing loaded JavaScript through `Debugger.setScriptSource`.

The current CDP documentation says that API's live-edit capability is deprecated and the command now fails because live edit is no longer available. ([Chrome DevTools][5])

Instead, if the AI needs to change JavaScript dynamically, I'd support things such as:

```text
source.patch_via_fetch(...)
source.override_resource(...)
runtime.evaluate(...)
workspace.edit_source_file(...)
page.reload(...)
```

For your own local application, editing the actual source file and letting the dev server/HMR update it is usually better anyway.

---

# Actual Inspector / Elements mode: YES

There are really **two inspectors** you can give the AI.

### Machine inspector

Use:

```text
DOM
CSS
Overlay
DOMDebugger
DOMSnapshot
Accessibility
Runtime
```

The `DOM` domain provides read/write DOM operations, and the CSS domain provides read/write access to stylesheets, rules and styles. ([Chrome DevTools][7])

Then provide tools like:

```text
inspector.element(selector)

inspector.parent(node)
inspector.children(node)

inspector.html(node)
inspector.attributes(node)

inspector.computed_styles(node)
inspector.matched_styles(node)

inspector.layout(node)

inspector.event_listeners(node)

inspector.highlight(node)

inspector.snapshot()
```

`DOMSnapshot.captureSnapshot` is especially interesting because it can return the document structure together with layout information and selected computed styles, including iframe/template contents and flattened Shadow DOM. ([Chrome DevTools][8])

That is excellent input for AI debugging.

---

## You can even implement the actual "pick element" inspector

Chrome exposes:

```text
Overlay.setInspectMode
```

When enabled, elements the user hovers over are highlighted, and selecting one produces an inspection event. ([Chrome DevTools][9])

So imagine your AI says:

> Click the inspect button and then click the broken element for me.

You invoke:

```text
inspector.pick()
```

Your mouse becomes the familiar DevTools element picker.

You hover:

```text
┌───────────────────────────┐
│ DIV .checkout-summary     │ ← highlighted
└───────────────────────────┘
```

You click.

Browserd receives:

```text
inspectNodeRequested
```

and gives the AI:

```text
node_handle = node_7192
```

Now:

```text
inspector.inspect(node_7192)
```

returns its HTML, CSS, dimensions, ancestors, event listeners, accessibility properties, etc.

That's a really nice human ↔ AI workflow.

---

# You can also open the REAL Chrome DevTools window

This surprised me a little too: current tip-of-tree CDP includes:

```text
Target.openDevTools
```

It can open DevTools for a page/tab target and specify the starting panel. Current supported panel IDs include Elements, Console, Network, Sources, Resources, Timeline, Recorder, Heap Profiler, Lighthouse and Security. It returns the target ID for the resulting DevTools page. ([chromedevtools.github.io][10])

So your MCP could literally have:

```text
devtools.open({
    tab_id: "tab_12",
    panel: "elements"
})
```

or:

```text
devtools.open({
    tab_id: "tab_12",
    panel: "network"
})
```

or:

```text
devtools.open({
    tab_id: "tab_12",
    panel: "heap-profiler"
})
```

A real DevTools window appears.

I would **not**, however, make clicking around the DevTools frontend your primary automation interface. `Target.openDevTools` is experimental, and the DevTools frontend UI is much less stable as an automation contract than the CDP domains underneath it. Use CDP for machine operations; open the actual UI when you want a human-visible inspector. ([chromedevtools.github.io][10])

---

# DOM breakpoints are also available

This gets particularly useful for weird UI bugs.

`DOMDebugger` supports breakpoints on DOM operations, event listeners and XHR activity. ([Chrome DevTools][11])

Your AI could say:

```text
debugger.break_on_dom_change(
    element = "#checkout",
    change = "subtree"
)
```

Then your app modifies the element.

**Chrome pauses on the JavaScript responsible for modifying it.**

Or:

```text
debugger.break_on_event("click")
```

Or:

```text
debugger.break_on_xhr("/payment")
```

Chrome also has an EventBreakpoints domain for breaking on native operations/events invoked from JavaScript. ([Chrome DevTools][12])

This can make an AI debugger much smarter than merely searching source code.

---

# Memory needs to be divided into categories

When you say **memory access**, there are four useful things.

### 1. Live JavaScript object memory

Already covered by `Runtime`.

```text
memory.object.inspect()
memory.object.properties()
memory.object.invoke()
```

The object handles refer to actual live JavaScript objects. CDP retains those remote objects until they are explicitly released or their object group is released, so your daemon needs proper lifetime management to avoid causing memory leaks itself. ([Chrome DevTools][6])

### 2. Heap objects

`HeapProfiler` is significantly deeper.

Chrome can:

```text
takeHeapSnapshot
startTrackingHeapObjects
startSampling
getSamplingProfile
stopSampling
collectGarbage
```

and it can map a Runtime object to a heap object identifier and retrieve objects from those heap identifiers. ([Chrome DevTools][13])

So:

```text
memory.heap.snapshot()
```

can produce:

```text
artifact://heap/heap_2026-08-17_1658.heapsnapshot
```

Instead of feeding that enormous thing into the LLM.

Heap snapshots arrive incrementally through `HeapProfiler.addHeapSnapshotChunk`, so browserd can stream them directly to disk. ([Chrome DevTools][13])

Perfect for your artifact architecture.

---

# Heap leak debugging

You could build:

```text
memory.heap.snapshot(label = "before")

...perform operation 100 times...

memory.gc()

memory.heap.snapshot(label = "after")

memory.heap.compare("before", "after")
```

Your analysis layer can calculate things such as:

```text
objects added
objects retained
size delta
constructor deltas
likely retainers
detached DOM growth
```

Chrome's heap profiler can also continuously track heap objects and allocation activity, including sampled allocations associated with stack information. ([Chrome DevTools][13])

That's how your AI eventually answers:

> Memory increases by ~18 MB every time the modal opens. Most retained objects originate from `ModalController.attach()` and the number of detached DOM nodes grows continuously.

---

# Native/browser memory profiling also exists

Separate from JavaScript heap profiling, CDP has a `Memory` domain.

It supports native allocation sampling, browser- and renderer-lifetime allocation profiles, DOM counters, memory-pressure simulation and leak-detection preparation. ([Chrome DevTools][14])

So you can expose:

```text
memory.native.start()
memory.native.sample()
memory.native.stop()

memory.dom_counters()

memory.prepare_leak_detection()

memory.pressure.simulate("critical")
```

That gets you beyond just JavaScript heap usage.

### But not arbitrary raw process memory

I would draw a clear boundary here.

CDP's Memory domain does **not** provide a general:

```text
read_memory(address, bytes)
write_memory(address, bytes)
```

API. Its documented capabilities are allocation profiling, counters, pressure/leak operations, etc. ([Chrome DevTools][14])

If you eventually need raw native process memory/debugging, that becomes a separate adapter to something like GDB/LLDB/WinDbg or OS-specific tooling.

I wouldn't put that in V1.

---

# Now the profiler — this could become REALLY useful

I would have a dedicated:

```text
profiler.*
```

service.

Chrome has an actual CPU Profiler through CDP. You can configure its sampling interval, start recording and stop to receive the recorded CPU profile. It also supports precise JavaScript code coverage. ([Chrome DevTools][15])

So:

```text
profiler.cpu.start(tab_id)

... reproduce lag ...

profiler.cpu.stop()
```

returns:

```text
artifact://profiles/profile_028.cpuprofile
```

plus an AI-sized summary:

```text
Duration: 18.4s

Top CPU consumers:

41.3% renderTable
17.8% calculatePositions
12.1% JSON.parse
 8.3% React reconciliation
...

Longest stack:
...
```

The full profile stays on disk.

---

# For serious performance debugging, use Tracing

This is the deeper layer.

CDP's `Tracing` domain records trace events and can return the recording as a stream rather than forcing everything through one giant protocol result. ([Chrome DevTools][16])

So:

```text
profile.trace.start({
    preset: "web-performance"
})
```

Reproduce:

```text
click
scroll
navigate
wait
```

Then:

```text
profile.trace.stop()
```

and browserd uses:

```text
Tracing.end
↓
IO stream
↓
artifact file
```

because CDP supports `ReturnAsStream`; the `IO` domain exists specifically for reading streams produced by DevTools. ([Chrome DevTools][16])

Now the AI doesn't receive a 200 MB trace.

It receives:

```text
artifact:
trace_928.json.gz

duration:
32.9 sec

main thread blocked:
8.24 sec

longest task:
1421 ms

likely source:
src/editor/layout.ts:381
```

---

# Performance metrics can run continuously

The lighter-weight `Performance` domain provides runtime performance metrics, while `PerformanceTimeline` can report timeline entries such as Largest Contentful Paint and layout shifts. ([Chrome DevTools][17])

I would continuously sample some of those into your session database:

```text
timestamp
tab_id

JS heap
documents
nodes
event listeners

task duration
script duration
layout duration
recalc style duration

LCP
layout shifts
...
```

Then:

```text
performance.query(
    tab_id,
    from = T1,
    to = T2
)
```

could provide graphs/data without having to start a giant trace every time.

---

# Also track Chromium processes

CDP's `SystemInfo.getProcessInfo` can enumerate running Chromium processes and returns their process types, PIDs and cumulative CPU time. ([Chrome DevTools][18])

That lets browserd correlate:

```text
Browser
PID 28191

Renderer: checkout
PID 28211

Renderer: docs
PID 28241

GPU
PID 28198

Utility
PID ...
```

with your targets.

Then your own process monitor can additionally sample OS-level:

```text
RSS
CPU %
threads
handles/fds
I/O
```

for those known PIDs.

That's extremely useful when something "hangs."

---

# I'd make profiling preset-driven

Instead of forcing the AI to understand 50 Chrome trace flags, give it commands like:

```text
profile.start("cpu")

profile.start("memory-leak")

profile.start("slow-page")

profile.start("hang")

profile.start("network-performance")

profile.start("full")
```

For example:

```text
profile.start("hang")
```

could internally activate:

```text
Tracing
CPU profiler
Performance metrics
process monitoring
console recording
network recording
heap counters
screenshots every N seconds
```

Then:

```text
profile.stop()
```

produces one **debug bundle**:

```text
debug_session_082/
│
├── manifest.json
│
├── summary.json
│
├── network.ndjson
│
├── network.har
│
├── console.ndjson
│
├── cpu.cpuprofile
│
├── trace.json.gz
│
├── heap.heapsnapshot
│
├── storage.json
│
├── dom-snapshot.json
│
└── screenshots/
    ├── 0001.png
    ├── 0002.png
    └── ...
```

Then the MCP result is only:

```text
Debug session complete.

artifact_id:
debug_082

CPU peak:
96%

Main-thread longest task:
1.48 s

Network errors:
3

Console errors:
7

Heap growth:
+84 MB

Full artifact:
artifact://debug/debug_082
```

And the AI can drill downward only when necessary:

```text
profile.top_functions(debug_082)

profile.long_tasks(debug_082)

profile.memory_growth(debug_082)

profile.timeline(debug_082, 20s, 25s)

profile.correlate(
    debug_082,
    event = "checkout click"
)
```

That **query-first design** is what will make the system usable by an LLM instead of drowning it in diagnostic data.

---

## So your full browser agent stack is becoming

```text
                 HUMAN + AI
                     │
                     ▼
              ┌─────────────┐
              │  browserd   │
              └──────┬──────┘
                     │
       ┌─────────────┼────────────────┐
       │             │                │
       ▼             ▼                ▼

     VISION        INSPECTOR       EXECUTION
   screenshot      DOM/CSS          console
   highlight       layout           runtime
   scroll          AX tree          debugger
   click           picker           variables

       │             │                │
       ├─────────────┼────────────────┤
       │             │                │
       ▼             ▼                ▼

    NETWORK        STORAGE          MEMORY
    headers        cookies          JS objects
    payload        localStorage     heap
    response       sessionStorage   native allocs
    WS frames      IndexedDB        DOM counters
    timings        Cache Storage    leak detection

                     │
                     ▼

                  PROFILER

                CPU profile
                tracing
                coverage
                timings
                long tasks
                processes
                footprints
                hangs

                     │
                     ▼

                ARTIFACT STORE

           searchable / sliceable /
           exportable / persistent
```

At that point, calling it a **browser automation tool** undersells it.

You're essentially building an **AI-native Chrome DevTools + Playwright + profiler + network recorder**, where the AI can visually reproduce a bug, inspect the element, inspect CSS, examine storage, inspect requests/responses, pause JavaScript, inspect and modify variables, profile CPU and heap, capture a trace, correlate all of those events by timestamp, and only load the relevant slices into its context.

That is the architecture I would target.

[1]: https://chromedevtools.github.io/devtools-protocol/tot/DOMStorage/ "Chrome DevTools Protocol - DOMStorage domain"
[2]: https://chromedevtools.github.io/devtools-protocol/tot/Storage/ "Chrome DevTools Protocol - Storage domain"
[3]: https://chromedevtools.github.io/devtools-protocol/tot/IndexedDB/ "Chrome DevTools Protocol - IndexedDB domain"
[4]: https://chromedevtools.github.io/devtools-protocol/tot/CacheStorage/ "Chrome DevTools Protocol - CacheStorage domain"
[5]: https://chromedevtools.github.io/devtools-protocol/tot/Debugger/ "Chrome DevTools Protocol - Debugger domain"
[6]: https://chromedevtools.github.io/devtools-protocol/tot/Runtime/ "Chrome DevTools Protocol - Runtime domain"
[7]: https://chromedevtools.github.io/devtools-protocol/tot/DOM/?utm_source=chatgpt.com "DOM domain - Chrome DevTools Protocol"
[8]: https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/ "Chrome DevTools Protocol - DOMSnapshot domain"
[9]: https://chromedevtools.github.io/devtools-protocol/tot/Overlay/ "Chrome DevTools Protocol - Overlay domain"
[10]: https://chromedevtools.github.io/devtools-protocol/tot/Target/ "Chrome DevTools Protocol - Target domain"
[11]: https://chromedevtools.github.io/devtools-protocol/tot/DOMDebugger/ "Chrome DevTools Protocol - DOMDebugger domain"
[12]: https://chromedevtools.github.io/devtools-protocol/tot/EventBreakpoints/?utm_source=chatgpt.com "Chrome DevTools Protocol - EventBreakpoints domain"
[13]: https://chromedevtools.github.io/devtools-protocol/tot/HeapProfiler/ "Chrome DevTools Protocol - HeapProfiler domain"
[14]: https://chromedevtools.github.io/devtools-protocol/tot/Memory/ "Chrome DevTools Protocol - Memory domain"
[15]: https://chromedevtools.github.io/devtools-protocol/tot/Profiler/ "Chrome DevTools Protocol - Profiler domain"
[16]: https://chromedevtools.github.io/devtools-protocol/tot/Tracing/ "Chrome DevTools Protocol - Tracing domain"
[17]: https://chromedevtools.github.io/devtools-protocol/tot/Performance/ "Chrome DevTools Protocol - Performance domain"
[18]: https://chromedevtools.github.io/devtools-protocol/tot/SystemInfo/?utm_source=chatgpt.com "SystemInfo domain - Chrome DevTools Protocol"

Yes. I would add an entire **Test Environment / Simulation subsystem** to `browserd`, alongside Network, Debugger, Storage, Memory, Profiler, etc.

That lets the AI do things humans normally do manually with DevTools testing controls, except programmatically and reproducibly:

```text
AI
 │
 ▼
browserd
 │
 ├── page
 ├── network
 ├── console
 ├── debugger
 ├── inspector
 ├── storage
 ├── memory
 ├── profiler
 │
 └── simulation / test-environment
        │
        ├── clock
        ├── timezone
        ├── network conditions
        ├── CPU throttling
        ├── device
        ├── geolocation
        ├── sensors
        ├── idle state
        ├── media preferences
        ├── permissions
        └── fault injection
```

And **time control should definitely be first-class**, not something hacked together with `Date.now = ...`.

## Time travel / clock control

Current Playwright has a dedicated Clock API. When installed, it can fake `Date`, `setTimeout`, `setInterval`, `requestAnimationFrame`, `requestIdleCallback`, `performance`, and their corresponding cancellation functions. Importantly, Playwright installs the clock for the whole `BrowserContext`, so all pages and iframes in that context share the controlled clock. ([Playwright][1])

So I'd expose:

```text
time.status()

time.install({
    time: "2026-08-17T09:00:00Z"
})

time.freeze({
    at: "2026-08-17T10:00:00Z"
})

time.advance("5m")

time.run("5m")

time.jump("7d")

time.resume()

time.set_wall_clock(
    "2030-01-01T00:00:00Z"
)
```

But there should be an important semantic difference between `advance`, `run`, and `jump`.

### `time.run("30m")`

This should mean:

> Pretend 30 minutes passed **and execute all timers/events that would fire during those 30 minutes**.

That's what Playwright's `clock.runFor()` is designed for: it advances the clock while firing the relevant time callbacks. ([Playwright][1])

So if the page does:

```js
setInterval(refreshToken, 60_000);
```

then:

```text
time.run("30m")
```

can exercise the interval behavior without making the AI wait 30 real minutes.

That's fantastic for automated testing.

---

### `time.jump("30m")`

Different meaning:

> Suddenly wake up 30 minutes later.

Playwright's `fastForward()` jumps the clock and only fires due timers at most once, which its documentation compares to closing a laptop and reopening it later. ([Playwright][1])

This lets the agent test things like:

```text
browser open
↓
user disappears for 3 hours
↓
comes back
↓
what happens?
```

That's a different bug category than allowing every timer to execute normally.

---

### `time.freeze()`

Example:

```text
time.freeze(
    "2026-12-31T23:59:58"
)
```

Now the AI can inspect the state.

Then:

```text
time.run("5s")
```

and see what happens across midnight/New Year.

Playwright's `pauseAt()` can move the controlled clock to a chosen instant and pause timer progression until time is explicitly advanced or resumed. ([Playwright][1])

So your agent could test:

```text
23:59:58
   ↓
23:59:59
   ↓
00:00:00
   ↓
new date
```

in seconds.

---

## Testing expiry becomes ridiculously easy

Imagine your app has:

```text
JWT expiration
session timeout
shopping cart expiration
OTP expiration
password-reset timeout
cache refresh
trial expiration
scheduled notification
subscription renewal
daily reset
midnight rollover
DST handling
```

The AI could perform:

```text
test.begin("session expiration")

time.install("2026-08-17T10:00:00Z")

page.login()

storage.session.inspect()

time.run("59m")

assert.user_logged_in()

time.run("2m")

assert.user_logged_out()

network.query({
    since: test.start
})

console.query({
    since: test.start
})

test.end()
```

No real hour needs to pass.

---

# Fixed clock vs timer clock should be separate

Playwright exposes another useful distinction.

`setFixedTime()` makes `Date.now()` and `new Date()` return the same fake timestamp while ordinary timers continue running. `setSystemTime()` changes the perceived system time without itself firing timers. ([Playwright][1])

So your API should reflect those concepts:

```text
time.date.freeze(...)
```

versus:

```text
time.scheduler.install(...)
```

because they're useful for different tests.

For example:

```text
time.date.freeze("2026-12-25T12:00:00Z")
```

means:

```text
Date.now()
      ↓
always Christmas
```

while animations, intervals, polling, etc. can continue.

---

# Time zone manipulation

Also absolutely expose:

```text
environment.timezone.set("America/New_York")

environment.timezone.set("Asia/Kolkata")

environment.timezone.set("Europe/London")
```

Chromium's CDP provides `Emulation.setTimezoneOverride`, and Playwright also supports browser timezone emulation. ([Chrome DevTools][2])

Now the AI can test the exact same application:

```text
UTC
India
New York
London
Tokyo
```

and look for bugs involving:

```text
date formatting
DST
midnight
calendar boundaries
timezone conversion
scheduled tasks
```

For example:

```text
environment.timezone.set("America/New_York")

time.set_wall_clock(
   "2026-11-01T05:55:00Z"
)

time.run("2h")
```

That gives your agent a way to explore time-zone transition behavior without changing your actual operating system clock.

---

# Chrome has a deeper virtual-time system too

CDP itself exposes experimental `Emulation.setVirtualTimePolicy`. It replaces real time with a synthetic time source across frames and can advance virtual time according to a specified budget; Chrome emits `virtualTimeBudgetExpired` when that budget is exhausted. ([Chrome DevTools][3])

So I'd have:

```text
time.mode = "playwright"
```

for most automated testing, and an advanced:

```text
time.mode = "cdp_virtual"
```

for Chromium-specific experiments.

I wouldn't casually mix both mechanisms in one target. Have `browserd` own the policy so the AI can't accidentally layer multiple independent fake clocks and create nonsense.

---

# And yes: CPU slowdown

This belongs right beside time controls.

CDP provides:

```text
Emulation.setCPUThrottlingRate
```

where `1` means normal CPU and `2` means approximately a 2× slowdown factor, etc. ([Chrome DevTools][3])

So expose:

```text
cpu.set_throttle(1)
cpu.set_throttle(2)
cpu.set_throttle(4)
cpu.set_throttle(6)

cpu.reset()
```

Then the agent can say:

```text
cpu.set_throttle(6)

profile.trace.start()

page.click("#open-editor")

page.wait_until_stable()

profile.trace.stop()
```

And determine:

```text
Normal CPU:
editor interactive after 480 ms

6× throttled CPU:
editor interactive after 3.8 s

Main bottleneck:
calculateLayout()
```

That's **much more useful** than testing only on your fast development machine.

---

# Network manipulation should be equally powerful

You already want full network inspection.

The same subsystem should also let the AI deliberately damage the network.

Current CDP has moved toward `Network.emulateNetworkConditionsByRule` for applying conditions to matching requests, paired with `Network.overrideNetworkState` when you also need navigator-level network state. The older general `Network.emulateNetworkConditions` command is deprecated. ([Chrome DevTools][4])

So expose something human-readable:

```text
network.simulation.set({
    latency: "400ms",
    download: "750kbps",
    upload: "250kbps"
})
```

Or:

```text
network.simulation.preset("slow-3g")
network.simulation.preset("bad-wifi")
network.simulation.preset("offline")
network.simulation.reset()
```

And because current CDP can apply network conditions using URL match rules, your daemon could also do things like:

```text
network.simulation.rule({
    url: "**/api/search/**",
    latency: "5s"
})
```

without slowing every resource. ([Chrome DevTools][4])

That's extremely useful.

---

# Fault injection should go beyond merely "slow"

I'd add a dedicated:

```text
fault.*
```

layer implemented primarily through Playwright routing/CDP Fetch interception.

For example:

```text
fault.network.abort({
    url: "**/analytics/**"
})

fault.network.delay({
    url: "**/api/payment",
    delay: "10s"
})

fault.network.replace_response({
    url: "**/api/user",
    status: 500,
    body: {...}
})

fault.network.drop_next({
    url: "**/api/save",
    count: 1
})
```

Then the AI could autonomously test:

> What happens if Save takes 20 seconds?

or:

> What happens if `/api/payment` returns HTTP 500?

or:

> What happens if the browser loses its connection immediately after clicking Submit?

And afterward it can inspect the network, screenshots, DOM and console to determine whether the application handled the condition correctly.

---

# Cache and service workers should be controllable too

Current CDP Network APIs can disable cache and bypass service workers. ([Chrome DevTools][4])

So expose:

```text
cache.disable()
cache.enable()
cache.clear()

service_worker.bypass(true)
service_worker.bypass(false)
```

This lets the AI ask:

```text
Is this bug caused by cached resources?
```

and actually test:

```text
screenshot before
↓
disable cache
↓
bypass service worker
↓
reload
↓
screenshot after
↓
compare network
```

instead of guessing.

---

# Device conditions

Your testing subsystem should be much broader than time.

CDP can override viewport/screen dimensions, DPR, mobile behavior, orientation and related device metrics. It also supports touch emulation. ([Chrome DevTools][3])

So I would expose:

```text
device.preset("desktop")
device.preset("iphone")
device.preset("tablet")

device.viewport({
    width: 375,
    height: 812,
    dpr: 3
})

device.orientation("portrait")
device.orientation("landscape")

device.touch.enable()
```

Now the AI can visually test responsive behavior itself:

```text
desktop screenshot
↓
tablet screenshot
↓
phone screenshot
↓
inspect overflow
↓
inspect CSS
↓
identify media query causing issue
```

---

# Geolocation

Also:

```text
location.set({
    latitude: ...,
    longitude: ...,
    accuracy: ...
})
```

CDP supports overriding latitude, longitude, accuracy, altitude, heading and speed, and Playwright exposes geolocation at BrowserContext level as well. ([Chrome DevTools][3])

You could therefore provide presets:

```text
location.preset("mumbai")
location.preset("new-york")
location.unavailable()
```

Useful for:

```text
maps
delivery applications
regional content
local pricing
location permissions
location failures
```

---

# Even sensors

Current CDP has experimental sensor emulation for things including accelerometer, gyroscope, ambient light, gravity, magnetometer and orientation sensors. ([Chrome DevTools][3])

So eventually:

```text
sensor.accelerometer.set(...)
sensor.gyroscope.set(...)
sensor.ambient_light.set(...)
sensor.orientation.set(...)
```

This probably isn't V1, but your architecture should allow it.

---

# Idle / locked computer simulation

Chrome also exposes an idle override:

```text
isUserActive
isScreenUnlocked
```

through the Emulation domain. ([Chrome DevTools][3])

Which suggests:

```text
user_state.active()
user_state.idle()

screen.lock()
screen.unlock()
```

Conceptually.

This lets the agent test applications that change behavior when:

```text
user inactive
screen locked
user returns
```

---

# Accessibility/environment simulation too

The same CDP domain can emulate media features and several vision deficiencies, including reduced contrast, blurred vision and common forms of color-vision deficiency. ([Chrome DevTools][3])

You could therefore have:

```text
environment.color_scheme("dark")
environment.color_scheme("light")

environment.reduced_motion(true)

environment.vision("deuteranopia")
environment.vision("protanopia")
environment.vision("reducedContrast")

environment.text_scale(1.5)
```

Then the AI takes screenshots and inspects the DOM/CSS.

That's a powerful automated accessibility/regression-testing capability.

---

# I would package all of this into "scenarios"

Instead of making the AI manually configure 15 switches every time:

```text
scenario.apply("slow-mobile")
```

might mean:

```text
viewport      390x844
touch         enabled
CPU           4× slowdown
network       high latency / low bandwidth
cache         normal
timezone      device default
```

While:

```text
scenario.apply("terrible-network")
```

might configure:

```text
latency       1500 ms
bandwidth     low
service worker normal
CPU           normal
```

And:

```text
scenario.apply("time-expiry")
```

could prepare controlled clocks.

The underlying controls remain available individually.

---

## The dedicated API I'd give the AI

| Area               | Example tools                                                         |
| ------------------ | --------------------------------------------------------------------- |
| Clock              | `time.install`, `time.freeze`, `time.run`, `time.jump`, `time.resume` |
| Wall time          | `time.set_wall_clock`, `time.set_fixed_date`                          |
| Time zone          | `environment.timezone.set`                                            |
| CPU                | `cpu.throttle`, `cpu.reset`                                           |
| Network            | `network.simulation.set`, `.offline`, `.reset`                        |
| Network faults     | `fault.network.delay`, `.abort`, `.replace_response`                  |
| Cache              | `cache.disable`, `.clear`                                             |
| Service worker     | `service_worker.bypass`                                               |
| Device             | `device.viewport`, `.preset`, `.orientation`                          |
| Input              | `device.touch`, mouse/keyboard controls                               |
| Location           | `location.set`, `.unavailable`                                        |
| Sensors            | `sensor.set`, `sensor.reset`                                          |
| Idle               | `user_state.idle`, `.active`                                          |
| Media              | `environment.color_scheme`, `.reduced_motion`                         |
| Vision             | `environment.vision`                                                  |
| Permissions        | `permissions.grant`, `.deny`, `.reset`                                |
| Test orchestration | `test.begin`, `test.checkpoint`, `test.end`                           |
| Presets            | `scenario.apply`, `scenario.reset`                                    |

And every environmental mutation should be **logged into the debugging timeline**.

For example:

```text
10:42:00.000 TEST START

10:42:01.211 page.click("#submit")

10:42:01.300 network POST /checkout

10:42:01.450 FAULT:
               response delayed 5 seconds

10:42:02.900 console.warn:
               "request taking too long"

10:42:06.451 response 200

10:42:06.480 DOM:
               spinner removed

10:42:06.510 screenshot
```

That synchronization is important.

Your profiler, network recorder, console recorder, screenshots, DOM events, debugger events **and simulated-world changes should share one timeline**.

Then the AI can answer:

> The UI freezes only when the API response exceeds ~4 seconds. At 5 seconds, `LoadingOverlay` blocks pointer events and isn't cleared until the request resolves. CPU is not the bottleneck; the issue is application loading-state handling.

That is the kind of autonomous debugging/testing system you're moving toward.

And I'd make **environment manipulation reversible and scoped**—ideally by `browser_id`, `context_id`, and where technically appropriate `target_id`—so an AI experiment on one test browser doesn't silently mutate all of your other running browser instances. Playwright's clock in particular is BrowserContext-wide, which is a good reason to model contexts explicitly in `browserd`. ([Playwright][1])

[1]: https://playwright.dev/docs/api/class-clock "Clock | Playwright"
[2]: https://chromedevtools.github.io/devtools-protocol/tot/Emulation/?utm_source=chatgpt.com "Emulation domain - Chrome DevTools Protocol"
[3]: https://chromedevtools.github.io/devtools-protocol/tot/Emulation/ "Chrome DevTools Protocol - Emulation domain"
[4]: https://chromedevtools.github.io/devtools-protocol/tot/Network/?utm_source=chatgpt.com "Network domain - Chrome DevTools Protocol"
