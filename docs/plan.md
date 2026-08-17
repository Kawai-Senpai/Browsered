@Web search I want to give a AI agent access o a browser, it can use browser automation, playwright or whatever to navigate, see whatever i have opened in that browser, apart form tha i can use it normally. it should be balso bal eto control te browser, etc bla bla, it shoudl also be able to see all consolve log, acess all tyhe html, css, js content, it should also be bale to modify them if needed. but most and most importantly it should be aable to acess lal debug functionlity and ACESS FUKK NETWORK LOGS< EACH EREQUEST< PAYLOAD< HEADER AND RESPONSE PROPERLY IN DETAILED WAY !!!!!!!!!!!  
now a simple extension will not make this amount of thing possible
so i was thinking how about i can write a custom driver or something?? in pyhn , jabvascript of whatever is best. so9 i spawn my own browser !?? and on the other side it connects to the AI using a MCP !! in a way that the mcp multiple instances can also discover and conenct to mulstipe instances of the browser !! if its running 

and i can also preinstall andopen up my own debug extensions that i have developed as it opens up ?? 

so that means a menu or bat using which i can open up this special broser just like any browser which starts and START logginga dn eveythinG! ! a mcp can iscover it anytime and control it, or fetch stuffs and do whatever it wants that was the idea

# AI-Native Debug Browser — Implementation Specification

## 1. Goal

Build a **normal, headed Chromium browser** that I can open and use like any other browser, but which automatically starts a local debugging/recording daemon alongside it.

The browser should:

* remain fully usable by a human;
* continuously record network traffic, console logs, errors, targets, performance data, etc.;
* expose full browser automation to an AI;
* expose Chrome DevTools Protocol capabilities to an AI;
* let an MCP client discover any running browser instance at any time;
* let multiple AI/MCP clients inspect or control multiple browser instances;
* retain large debugging data locally rather than injecting everything into LLM context;
* expose query, search, slicing, export, and artifact APIs for large logs;
* support dedicated debugging, storage, profiling, environment-emulation, and testing tools;
* optionally open the real Chrome DevTools UI.

The central idea is:

```text
Human
  │
  │ uses browser normally
  ▼
┌─────────────────────────────────────────────┐
│           SPECIAL CHROMIUM BROWSER          │
│                                             │
│ Normal tabs / webpages / extensions         │
│                                             │
│ CDP enabled automatically                   │
└─────────────────┬───────────────────────────┘
                  │
                  │ persistent CDP connection
                  ▼
┌─────────────────────────────────────────────┐
│                 browserd                    │
│                                             │
│ automation                                  │
│ network recorder                            │
│ console recorder                            │
│ DOM/CSS inspector                           │
│ debugger                                    │
│ storage manager                             │
│ memory profiler                             │
│ CPU/performance profiler                    │
│ test/environment simulator                  │
│ artifact store                              │
│ browser registry                            │
│ MCP server                                  │
└─────────────────┬───────────────────────────┘
                  │
                  │ MCP
                  ▼
             AI / Agent
```

---

# 2. User Experience

The browser should feel like launching any normal browser.

On Windows I should be able to have:

```text
AI Browser.bat
```

or:

```text
AI Browser.exe
```

or a tray/menu application.

Double-clicking it should:

```text
1. Start browserd if it is not already running.
2. Create/register a new browser instance.
3. Launch headed Chromium.
4. Load the selected persistent profile.
5. Load my debugging extensions.
6. Enable CDP.
7. Automatically attach browserd.
8. Start recording immediately.
9. Open the browser window.
10. Make the browser available to MCP clients.
```

I should then simply browse normally.

Example:

```text
double click:

    AI Browser.bat

             ↓

browserd starts

             ↓

Chromium launches

             ↓

┌─────────────────────────────────────┐
│ Chrome                              │
│                                     │
│ [tabs...]                           │
│                                     │
│ I browse normally                   │
│                                     │
└─────────────────────────────────────┘

             simultaneously

browserd:
✓ recording network
✓ recording console
✓ recording exceptions
✓ watching tabs
✓ watching workers
✓ monitoring storage
✓ accepting MCP connections
```

The AI does **not** need to be connected when the browser starts.

Everything important should already be recording.

Later, five minutes, one hour, or several hours later, an MCP client can connect and ask:

```text
browser.list()
```

and discover the currently running browser.

---

# 3. Recommended Technology Stack

Primary implementation:

```text
Language:
TypeScript / Node.js

Browser:
Playwright bundled Chromium

Automation:
Playwright

Low-level debugging:
Chrome DevTools Protocol

AI interface:
MCP server

Persistent metadata:
SQLite

Large artifacts:
filesystem/blob storage

Optional deep networking:
Chromium NetLog

Optional desktop UI:
Tauri / Electron / native tray utility
```

Node/TypeScript is recommended because the whole application is highly asynchronous:

```text
network event
console event
new tab
worker created
breakpoint hit
WebSocket frame
trace event
MCP request
browser process exits
```

and Node fits that model naturally.

---

# 4. Main Process: `browserd`

The central component should be a persistent local daemon:

```text
browserd
```

Do not make the MCP implementation itself responsible for browser management.

Instead:

```text
                     browserd
                         │
          ┌──────────────┼──────────────┐
          │              │              │
          ▼              ▼              ▼
       Chromium        SQLite       Artifacts
          │
          ▼
      CDP events

                         ▲
                         │
                    MCP Adapter
                         ▲
                         │
                        AI
```

This means additional interfaces can eventually be added:

```text
MCP
CLI
REST
WebSocket
desktop UI
VS Code integration
test runner
```

without rewriting browser control.

---

# 5. Browser Launcher

Create a launcher command:

```bash
browserd launch
```

Options:

```bash
browserd launch \
  --profile development \
  --name "Development Browser" \
  --extensions ./extensions \
  --netlog
```

Equivalent Windows launcher:

```bat
@echo off

start "" "%~dp0browserd.exe" daemon

timeout /t 1 /nobreak >nul

"%~dp0browserd.exe" launch ^
  --profile default ^
  --name "AI Browser"
```

Better eventual UX:

```text
AI Browser
────────────────────────

[ Open Default Browser ]

Profiles
  Development
  Testing
  Personal Debug
  Staging

Running Browsers
  ● Development       4 tabs
  ● Testing           2 tabs

[ New Browser ]

Settings
Extensions
Artifacts
MCP Status
```

---

# 6. Chromium Startup

Each instance receives its own persistent profile:

```text
profiles/
├── development/
├── testing/
├── staging/
└── profile-004/
```

Launch headed Chromium with CDP enabled.

Conceptually:

```text
Chromium
--user-data-dir=<profile>
--remote-debugging-port=0
--log-net-log=<optional path>
```

Using a dedicated browser profile is important.

Do **not** depend on attaching automation to the user's normal Chrome profile.

Browserd should read the assigned CDP endpoint and establish a persistent connection.

---

# 7. Browser Instance Registry

Browserd maintains a registry:

```text
BrowserRegistry
```

Example:

```json
{
  "browser_id": "br_01",
  "name": "Development",
  "pid": 21822,
  "profile": "development",
  "cdp_endpoint": "ws://127.0.0.1:43821/...",
  "started_at": "...",
  "status": "ready"
}
```

Multiple browsers:

```text
browserd
 │
 ├── br_01 ──CDP── Chromium
 ├── br_02 ──CDP── Chromium
 └── br_03 ──CDP── Chromium
```

MCP does not search operating-system processes directly.

It simply calls:

```text
browser.list()
```

Browserd returns its registry.

---

# 8. MCP Discovery

Run one permanent local MCP endpoint:

```text
http://127.0.0.1:7331/mcp
```

or optionally stdio:

```text
browserd mcp
```

Multiple agents can connect to the same MCP server:

```text
Claude ─────────┐
                │
Codex ──────────┼────► browserd
                │
Custom Agent ───┘
```

Every operation uses explicit handles:

```text
browser_id
context_id
target_id
tab_id
request_id
console_event_id
artifact_id
debug_session_id
```

Example:

```text
network.query({
    browser_id: "br_02",
    tab_id: "tab_17"
})
```

---

# 9. Target Discovery

Inside a browser there can be more than tabs:

```text
Browser
├── Page
├── Page
│   ├── iframe
│   └── worker
├── service worker
└── extension worker
```

Browserd should use CDP `Target` functionality to discover and automatically attach to:

```text
pages
iframes
workers
shared workers
service workers
extension workers
other relevant targets
```

Browserd keeps a mapping:

```text
browser_id
    ↓
target_id
    ↓
session_id
```

Example:

```text
br_01

target:
tgt_92

cdp_target:
3D82491...

cdp_session:
E99AB10...
```

Browserd should expose its own stable IDs to the AI rather than raw CDP identifiers where possible.

---

# 10. Continuous Recording Principle

This is one of the most important architectural rules:

> Recording happens continuously whether an AI is connected or not.

Do not implement:

```text
AI asks network events
      ↓
start recording
```

Instead:

```text
browser starts
      ↓
recording begins
      ↓
everything stored
      ↓
AI connects later
      ↓
AI queries history
```

Continuously record:

```text
network
console
exceptions
WebSocket frames
navigations
target lifecycle
page crashes
important performance metrics
environment/test changes
optional DOM events
```

---

# 11. Network Recorder

Network should be one of the strongest subsystems.

Every request gets a durable internal ID:

```text
req_0000009281
```

Store:

```text
timestamp
browser
tab
frame
worker
URL
method
resource type
initiator
initiator stack

request headers
request cookies
request body
POST data

response status
response headers
response cookies
response body

MIME type
protocol
remote address
timings

cache information
service worker information

redirects
failure reason

WebSocket association
```

Network events should be collected from CDP.

Large bodies are written directly to artifacts.

Example:

```text
network/
├── session.sqlite
├── bodies/
│   ├── req_1001.request.json
│   ├── req_1001.response.json
│   ├── req_1002.response.bin
│   └── ...
└── exports/
```

MCP:

```text
network.query(...)
network.inspect(...)
network.request_headers(...)
network.response_headers(...)
network.request_body(...)
network.response_body(...)
network.timings(...)
network.initiator(...)
```

---

# 12. Large Network Payload Handling

Never push a 50 MB response directly into model context.

Instead:

```text
AI asks:
network.inspect(req_921)

browserd returns:

status: 200
mime: application/json
size: 48.2 MB

preview:
"{\"data\": ..."

artifact:
art_812
```

The AI then uses:

```text
artifact.stat(art_812)

artifact.read(
    art_812,
    offset=0,
    length=65536
)

artifact.search(
    art_812,
    "payment_failed"
)

artifact.read_lines(
    art_812,
    start=500,
    count=100
)
```

For JSON:

```text
artifact.json.query(...)
artifact.json.keys(...)
artifact.json.path(...)
```

For text:

```text
artifact.grep(...)
```

For HTML/XML:

```text
artifact.search(...)
artifact.extract(...)
```

---

# 13. Network Export

Provide:

```text
network.export.har(...)
network.export.json(...)
network.export.ndjson(...)
network.export.requests(...)
network.export.session(...)
```

Example:

```text
network.export({
    browser_id: "br_01",
    tab_id: "tab_3",
    after: "...",
    before: "...",
    format: "har"
})
```

Returns:

```text
artifact_id:
art_har_82

path:
C:\AI-Browser\data\exports\session82.har
```

HAR should be an export format.

The internal canonical storage should remain SQLite + blobs/files.

---

# 14. Console System

Continuously capture:

```text
console.log
console.info
console.warn
console.error
console.debug
exceptions
stack traces
source URL
line
column
execution context
arguments
timestamp
```

Store to:

```text
console.ndjson
```

and/or SQLite.

Tools:

```text
console.query(...)
console.search(...)
console.errors(...)
console.exceptions(...)
console.read_range(...)
console.export(...)
```

Example:

```text
console.query({
    tab_id: "tab_7",
    levels: ["error", "warn"],
    after: "...",
    before: "...",
    search: "auth",
    limit: 100
})
```

Use pagination/cursors for large logs.

---

# 15. DevTools Console Execution

Expose:

```text
console.execute(...)
```

implemented using:

```text
Runtime.evaluate
```

or Playwright `page.evaluate`.

Example:

```text
console.execute({
    tab_id: "tab_7",
    expression:
      "document.querySelector('#payment').dataset"
})
```

The AI can therefore execute arbitrary debugging JavaScript inside the selected page.

---

# 16. Visual Browser Automation

The AI must be able to behave like a browser agent.

Tools:

```text
tabs.list
tabs.activate
tabs.new
tabs.close

page.navigate
page.reload
page.back
page.forward

page.click
page.double_click
page.hover

page.type
page.fill
page.press

page.scroll
page.scroll_to
page.scroll_into_view

page.drag
page.drop

page.wait
page.wait_for_selector

page.screenshot
page.screenshot_full
```

The browser remains headed so the human sees exactly what is happening.

---

# 17. Screenshots / AI Vision

Screenshots should be available both directly to the AI and as persistent artifacts.

```text
page.screenshot({
    tab_id: "tab_4",
    mode: "viewport"
})
```

returns:

```text
image
+
artifact_id
```

Full page:

```text
page.screenshot_full(...)
```

This allows the model to:

```text
see rendered UI
reason visually
click things
scroll
take another screenshot
verify result
```

---

# 18. Inspector / DOM

Provide an AI-native equivalent of the Elements inspector.

Tools:

```text
dom.summary
dom.query
dom.query_all

dom.inspect
dom.parent
dom.children

dom.attributes
dom.text
dom.html
dom.outer_html

dom.bounding_box

dom.set_attribute
dom.remove_attribute
dom.set_html
dom.remove
```

For huge documents:

```text
dom.export(...)
```

returns an artifact instead of enormous model content.

---

# 19. Element Highlighting

Provide:

```text
inspector.highlight(node)
inspector.unhighlight()
```

Using Chrome's Overlay APIs.

Useful workflow:

```text
AI identifies selector
      ↓
highlight element
      ↓
take screenshot
      ↓
AI visually confirms
```

---

# 20. Human Element Picker

Provide:

```text
inspector.pick()
```

This activates DevTools-style element-selection mode.

The human can hover and click an element.

Browserd receives the selected node.

Example:

```text
inspector.pick()

→ waiting for human selection

human clicks broken button

→ node_192
```

Then AI calls:

```text
inspector.inspect(node_192)
```

This is extremely useful for:

> "This thing here is broken. Inspect it."

---

# 21. CSS Inspector

Expose:

```text
css.computed(node)
css.matched_rules(node)
css.inline(node)
css.stylesheets()
css.stylesheet_source(...)

css.set_property(...)
css.set_rule(...)
css.set_stylesheet(...)
```

The AI should be able to determine:

```text
which selector applied
where rule came from
specificity
computed result
layout dimensions
z-index
overflow
visibility
display
position
transform
```

Example AI debugging:

```text
Button invisible

AI:
1. screenshot
2. inspect DOM
3. inspect computed CSS
4. inspect ancestors
5. determine parent has overflow:hidden
```

---

# 22. DOM Snapshot

Provide:

```text
inspector.snapshot(...)
```

This should capture:

```text
DOM
layout information
selected computed styles
shadow DOM
iframes where available
```

Store large snapshots as artifacts.

This gives the AI a structured representation of the current rendered document.

---

# 23. Accessibility Tree

Add:

```text
accessibility.snapshot
accessibility.inspect
```

So the agent can understand:

```text
roles
labels
names
states
focus
accessibility relationships
```

This is useful both for interaction and accessibility testing.

---

# 24. JavaScript Sources

Tools:

```text
js.scripts
js.source
js.source_range
js.search_source
js.export_source
```

Do not send giant bundles to the AI.

Example:

```text
js.search_source("/api/payment")

→
src/api/payment.ts:81
src/hooks/usePayment.ts:122
bundle.js:198812
```

Then:

```text
js.source_range(
    script,
    70,
    110
)
```

---

# 25. JavaScript Debugger

Provide a dedicated debugger interface.

```text
debugger.enable

debugger.scripts
debugger.source

debugger.breakpoint.set
debugger.breakpoint.remove

debugger.pause
debugger.resume

debugger.step_into
debugger.step_over
debugger.step_out

debugger.pause_on_exceptions

debugger.stack
debugger.frames
debugger.scopes
debugger.variables

debugger.evaluate_on_frame
debugger.set_variable
```

Example:

```text
BREAKPOINT HIT

submitPayment()
payment.ts:182

locals:
amount = undefined
currency = "USD"
token = "..."
```

The AI can inspect those values.

Potentially:

```text
debugger.set_variable(
    frame=0,
    name="amount",
    value=4999
)
```

then:

```text
debugger.resume()
```

---

# 26. DOM / Event / XHR Breakpoints

Expose specialized debugging tools:

```text
debugger.break_on_dom_change(...)
debugger.break_on_attribute_change(...)
debugger.break_on_node_removal(...)

debugger.break_on_event(...)
debugger.break_on_xhr(...)
```

This lets the AI ask questions such as:

```text
"What JavaScript is changing this element?"

"What function is firing this request?"

"What code handles this click?"
```

and Chrome can pause exactly at the responsible execution point.

---

# 27. Real DevTools Window

Provide optional:

```text
devtools.open({
    tab_id,
    panel
})
```

Panels:

```text
elements
console
network
sources
application/resources
performance
heap profiler
security
```

This opens the actual visible Chrome DevTools interface.

However:

```text
CDP = machine API
DevTools frontend = human UI
```

The AI should primarily use CDP tools.

The actual DevTools window is supplemental.

---

# 28. Storage System

Provide:

```text
storage.local.*
storage.session.*
storage.cookies.*
storage.indexeddb.*
storage.cache.*
```

### Local storage

```text
storage.local.list
storage.local.get
storage.local.set
storage.local.delete
storage.local.clear
```

### Session storage

```text
storage.session.list
storage.session.get
storage.session.set
storage.session.delete
storage.session.clear
```

### Cookies

```text
storage.cookies.list
storage.cookies.get
storage.cookies.set
storage.cookies.delete
storage.cookies.clear
```

### IndexedDB

```text
storage.indexeddb.databases
storage.indexeddb.describe
storage.indexeddb.query
storage.indexeddb.put
storage.indexeddb.delete
storage.indexeddb.export
```

### Cache Storage

```text
storage.cache.list
storage.cache.entries
storage.cache.body
storage.cache.delete
storage.cache.clear
```

---

# 29. Runtime Object Inspector

Expose live JavaScript objects.

```text
runtime.evaluate
runtime.properties
runtime.call_function
runtime.release_object
```

AI can inspect:

```text
window
React state exposed to page
request objects
application objects
arrays
maps
sets
custom classes
```

Object handles should be tracked and released properly so browserd itself doesn't introduce memory leaks.

---

# 30. Memory / Heap Profiler

Separate memory into multiple systems.

### JavaScript heap

```text
memory.heap.snapshot
memory.heap.start_tracking
memory.heap.stop_tracking
memory.heap.start_sampling
memory.heap.stop_sampling
memory.heap.collect_garbage
```

Large heap snapshot:

```text
heap_20260818_0032.heapsnapshot
```

stored as an artifact.

### Comparison

```text
memory.heap.snapshot("before")

perform operation

memory.heap.snapshot("after")

memory.heap.compare("before", "after")
```

AI-facing summary:

```text
heap growth:
+82 MB

detached DOM nodes:
+411

largest constructor growth:
EditorNode +21 MB
```

---

# 31. Native Chromium Memory

Expose separately:

```text
memory.native.start
memory.native.sample
memory.native.stop

memory.dom_counters
memory.prepare_leak_detection
```

This is profiling/instrumentation.

It is **not arbitrary raw process-memory read/write**.

Raw native-memory debugging would require a separate GDB/LLDB/WinDbg integration and should not be part of the first implementation.

---

# 32. CPU Profiler

Provide:

```text
profile.cpu.start
profile.cpu.stop
profile.cpu.summary
profile.cpu.top_functions
profile.cpu.export
```

Artifact:

```text
profile_829.cpuprofile
```

AI receives a small summary:

```text
duration: 12.8 sec

CPU:
renderRows             39%
calculateLayout        18%
JSON.parse             11%
...
```

---

# 33. Performance Tracing

Provide:

```text
profile.trace.start
profile.trace.stop
profile.trace.summary
profile.trace.long_tasks
profile.trace.export
```

Large trace files should stream directly to artifacts.

Example:

```text
trace_218.json.gz
```

Do not inject trace JSON directly into the LLM.

---

# 34. Continuous Performance Metrics

Record lightweight metrics continuously:

```text
JS heap size
DOM nodes
documents
event listeners
task duration
script duration
layout duration
style recalculation
LCP
layout shifts
process CPU
process memory
```

Store them with timestamps.

Provide:

```text
performance.query(...)
performance.summary(...)
performance.compare(...)
```

---

# 35. Chromium Process Monitoring

Track:

```text
browser process
renderer processes
GPU
utility processes
workers where identifiable
```

Correlate:

```text
PID
target
tab
CPU
RSS
threads
I/O
```

Useful for hangs and memory leaks.

---

# 36. Unified Debug Sessions

Allow:

```text
debug_session.start(...)
```

Browserd starts collecting an enhanced bundle.

Example preset:

```text
debug_session.start({
    preset: "hang"
})
```

Internally enables:

```text
network
console
CPU profiling
trace
process monitoring
performance
screenshots
```

Then:

```text
debug_session.stop()
```

produces:

```text
debug_082/
├── manifest.json
├── summary.json
├── network.sqlite
├── network.har
├── console.ndjson
├── trace.json.gz
├── cpu.cpuprofile
├── performance.ndjson
├── process.ndjson
├── storage.json
└── screenshots/
```

---

# 37. Browser Clock / Time Control

Provide first-class testing tools.

```text
time.install
time.freeze
time.run
time.jump
time.resume

time.set_fixed_date
time.set_wall_clock
```

Important distinction:

```text
time.run("1h")
```

means:

> advance one simulated hour while executing scheduled timers.

Whereas:

```text
time.jump("1h")
```

means:

> suddenly wake up one hour later.

This lets the AI test:

```text
session expiration
OTP expiration
JWT expiration
shopping-cart timeout
midnight rollover
scheduled UI refresh
daily reset
trials
subscriptions
timer bugs
```

without waiting real time.

---

# 38. Timezone Control

Provide:

```text
environment.timezone.set("Asia/Kolkata")
environment.timezone.set("America/New_York")
environment.timezone.set("Europe/London")
environment.timezone.reset()
```

Useful for:

```text
DST bugs
date formatting
midnight bugs
calendar bugs
regional schedules
```

---

# 39. CPU Throttling

Provide:

```text
cpu.throttle(1)
cpu.throttle(2)
cpu.throttle(4)
cpu.throttle(6)
cpu.reset()
```

Allows the AI to reproduce problems hidden by powerful developer hardware.

Example:

```text
CPU ×6
+
performance trace
+
interaction
```

and identify slow JavaScript/layout/rendering.

---

# 40. Network Simulation

Provide:

```text
network.simulation.set
network.simulation.offline
network.simulation.reset
```

Preset examples:

```text
network.simulation.preset("slow-mobile")
network.simulation.preset("bad-wifi")
network.simulation.preset("offline")
```

Controls:

```text
latency
download bandwidth
upload bandwidth
packet-related behavior where supported
```

---

# 41. Network Fault Injection

Provide a separate intentional failure layer:

```text
fault.network.delay
fault.network.abort
fault.network.replace_response
fault.network.change_status
fault.network.drop_next
```

Examples:

```text
delay /api/payment by 10 seconds

make /api/user return HTTP 500

drop next save request

return malformed JSON

simulate offline after request begins
```

This allows autonomous robustness testing.

---

# 42. Cache / Service Worker Controls

Provide:

```text
cache.disable
cache.enable
cache.clear

service_worker.bypass
service_worker.restore
```

The AI can test:

```text
is this a stale cache bug?
is the service worker serving an old resource?
does it work after bypassing SW?
```

---

# 43. Device Simulation

Provide:

```text
device.preset
device.viewport
device.orientation
device.touch
device.pixel_ratio
```

Example:

```text
device.preset("desktop")

device.preset("phone")

device.viewport({
    width: 390,
    height: 844,
    dpr: 3
})
```

Then the AI can take screenshots and inspect responsive CSS.

---

# 44. Geolocation

Provide:

```text
location.set
location.unavailable
location.reset
```

Useful for:

```text
maps
delivery
geo-specific UI
regional functionality
permission handling
```

---

# 45. Sensors

Optional advanced functionality:

```text
sensor.accelerometer
sensor.gyroscope
sensor.orientation
sensor.ambient_light
sensor.reset
```

Not necessary for initial implementation, but the architecture should support it.

---

# 46. User Idle / Screen State

Provide environment simulation:

```text
user_state.active
user_state.idle

screen_state.unlocked
screen_state.locked
```

Useful for applications responding to inactivity.

---

# 47. Accessibility / Media Environment

Expose:

```text
environment.color_scheme("dark")
environment.color_scheme("light")

environment.reduced_motion(true)

environment.vision("deuteranopia")
environment.vision("protanopia")
environment.vision("reducedContrast")
```

Useful for automated accessibility testing.

---

# 48. Permission Management

Provide:

```text
permissions.list
permissions.grant
permissions.deny
permissions.reset
```

For things such as:

```text
notifications
geolocation
clipboard
camera
microphone
```

where the browser supports programmatic handling.

---

# 49. Testing Scenarios

Higher-level presets should compose the low-level controls.

```text
scenario.apply("slow-mobile")
scenario.apply("terrible-network")
scenario.apply("offline")
scenario.apply("slow-cpu")
scenario.apply("session-expiry")
scenario.apply("memory-leak")
scenario.reset()
```

Example:

```text
slow-mobile
────────────────

viewport     390x844
DPR          3
touch        enabled
CPU          4× slower
network      high latency
bandwidth    limited
```

The individual controls remain available.

---

# 50. Test Runner

Eventually provide:

```text
test.begin
test.checkpoint
test.assert
test.end
```

Example:

```text
test.begin("checkout expiry")

time.freeze("2026-08-18T00:00:00Z")

page.navigate(...)

page.login()

time.run("59m")

test.assert("still logged in")

time.run("2m")

test.assert("logged out")

test.end()
```

Every test action should be timestamped.

---

# 51. Unified Timeline

Everything should share one timeline.

Example:

```text
10:42:00.000 TEST START

10:42:01.200 CLICK
#submit

10:42:01.301 NETWORK
POST /checkout

10:42:01.304 ENVIRONMENT
network delay → 5000ms

10:42:02.101 CONSOLE
"waiting for checkout"

10:42:06.302 NETWORK
200 /checkout

10:42:06.430 DOM
spinner removed

10:42:06.490 SCREENSHOT
ss_921
```

This lets the AI correlate:

```text
visual state
console
network
JavaScript
CPU
DOM
profiling
environment changes
```

instead of treating them as independent systems.

---

# 52. Artifact Store

Central large-data storage:

```text
data/
└── browsers/
    └── br_01/
        └── sessions/
            └── sess_001/
                ├── session.sqlite
                ├── console/
                ├── network/
                ├── screenshots/
                ├── DOM/
                ├── sources/
                ├── profiles/
                ├── heaps/
                ├── traces/
                └── exports/
```

Every large item gets:

```text
artifact_id
mime
size
path
created_at
browser_id
tab_id
source
metadata
```

---

# 53. Artifact API

Provide:

```text
artifact.stat
artifact.read
artifact.read_range
artifact.read_lines

artifact.search
artifact.grep

artifact.json.query
artifact.json.keys

artifact.export
artifact.delete
```

This is essential because LLM context is finite.

The architecture should always be:

```text
BIG DEBUG DATA
      ↓
local artifact
      ↓
index/search/filter
      ↓
small relevant slice
      ↓
AI
```

---

# 54. Raw CDP Escape Hatch

Even after providing specialized tools, expose:

```text
cdp.send
```

Example:

```text
cdp.send({
    browser_id: "br_01",
    target_id: "tgt_19",
    method: "Network.getResponseBody",
    params: {
        requestId: "8123.71"
    }
})
```

This makes new or obscure Chrome debugging functionality immediately accessible without waiting for a custom wrapper.

The dedicated APIs should remain the preferred interface.

---

# 55. Suggested MCP Tool Namespaces

```text
browser.*
tabs.*
page.*

inspector.*
dom.*
css.*
accessibility.*

console.*
js.*
runtime.*
debugger.*

network.*
websocket.*

storage.*

memory.*
profile.*
performance.*
process.*

time.*
cpu.*
environment.*
device.*
location.*
sensor.*
permissions.*

cache.*
service_worker.*
fault.*

scenario.*
test.*

artifact.*

devtools.*

cdp.*
```

---

# 56. Human vs AI Control Modes

Because both the human and AI can interact with the browser, add:

```text
control.mode("observe")
control.mode("shared")
control.mode("agent")
control.mode("paused")
```

Meaning:

```text
observe
AI can inspect but cannot mutate.

shared
human and AI can interact.

agent
AI has interaction ownership.

paused
AI cannot perform actions.
```

Expose an obvious physical/manual:

```text
PAUSE AI CONTROL
```

button in the launcher/tray UI.

---

# 57. Extension Support

Maintain extension directories:

```text
extensions/
├── debugging-extension/
├── internal-tools/
└── ...
```

Launch them automatically with the controlled Chromium build.

The extension can provide additional features, but it should **not** be the core of browser instrumentation.

Core debugging should remain:

```text
browserd
+
CDP
+
Playwright
```

Extensions are optional enhancements.

---

# 58. Startup Sequence

Final startup sequence:

```text
USER

double-clicks:

AI Browser
       │
       ▼
Launcher
       │
       ├─ ensure browserd running
       │
       ▼
browserd
       │
       ├─ allocate browser_id
       ├─ create session directory
       ├─ load profile config
       ├─ configure extensions
       ├─ configure NetLog if enabled
       │
       ▼
launch Chromium
       │
       ├─ headed browser
       ├─ persistent profile
       ├─ CDP enabled
       │
       ▼
browserd discovers CDP
       │
       ├─ connect
       ├─ discover targets
       ├─ auto-attach
       │
       ├─ Network.enable
       ├─ Runtime.enable
       ├─ Debugger availability
       ├─ Log.enable
       ├─ Performance monitoring
       │
       ▼
continuous recording starts
       │
       ▼
BrowserRegistry registers:

br_01 = READY

       │
       ▼
MCP can now discover it
```

---

# 59. Late AI Connection

This is one of the primary use cases.

```text
09:00 browser starts

09:01 user navigates

09:03 login request

09:04 console warning

09:07 API fails

09:10 user opens AI

09:10 AI connects via MCP
```

AI:

```text
browser.list()
```

gets:

```text
br_01
Development Browser
running for 10 minutes
5 tabs
recording active
```

Then:

```text
network.query({
    browser_id: "br_01",
    after: "09:00"
})
```

Everything from before the AI connected is still available.

That is a fundamental design requirement.

---

# 60. Example Autonomous Debugging Workflow

User:

```text
"Checkout failed. Figure out why."
```

AI:

```text
browser.list()
```

↓

```text
tabs.list(br_01)
```

↓

```text
page.screenshot(tab_checkout)
```

AI visually sees:

```text
Payment failed
```

↓

```text
console.query(
    tab_checkout,
    levels=["error"]
)
```

Finds:

```text
TypeError at submitPayment()
```

↓

```text
network.query(
    tab_checkout,
    type=["xhr","fetch"]
)
```

Finds:

```text
POST /api/payment → 400
```

↓

```text
network.inspect(req_281)
```

Finds:

```text
payload:

{
    "token": "...",
    "currency": "USD"
}

response:

{
    "error": "amount required"
}
```

↓

```text
js.search_source("submitPayment")
```

↓

```text
js.source_range(...)
```

Finds code omitted `amount`.

↓

AI can optionally:

```text
debugger.breakpoint.set(...)
page.click(...)
debugger.variables(...)
```

and verify the live state.

This is the intended debugging experience.

---

# 61. Example Performance Workflow

User:

```text
"This page freezes sometimes."
```

AI:

```text
profile.trace.start()

profile.cpu.start()

cpu.throttle(4)

page.perform_problematic_action()

profile.cpu.stop()

profile.trace.stop()
```

Then:

```text
profile.trace.long_tasks()
profile.cpu.top_functions()
performance.query(...)
```

AI concludes:

```text
Main thread blocked for 1.8 seconds.

72% of CPU during freeze:
renderLargeTree()

Memory increased 24 MB.

Network was not responsible.
```

---

# 62. Example Time-Test Workflow

User:

```text
"Check whether session expiry works."
```

AI:

```text
time.install("2026-08-18T00:00:00Z")

page.login()

time.run("29m")

verify logged in

time.run("2m")

verify logout

network.query(...)
console.query(...)
storage.session.list(...)
```

Minutes of real time are unnecessary.

---

# 63. Example Visual/CSS Debugging Workflow

User:

```text
"This dropdown looks wrong."
```

AI:

```text
page.screenshot()
```

↓

AI sees dropdown under modal.

↓

```text
dom.query(".dropdown")
```

↓

```text
inspector.highlight(node)
```

↓

```text
page.screenshot()
```

↓

```text
css.computed(node)
css.matched_rules(node)
```

Finds:

```text
dropdown z-index = 10
modal z-index = 1000
```

AI identifies the styling problem.

---

# 64. Development Phases

## Phase 1 — Core Browser

Implement:

```text
browserd
launcher
Chromium startup
persistent profiles
browser registry
CDP connection
MCP server
tabs
screenshots
click/type/scroll/navigation
basic artifacts
```

This establishes:

```text
Human browser
+
AI browser control
```

---

## Phase 2 — Debug Recording

Implement:

```text
network recorder
response bodies
request bodies
console
exceptions
WebSockets
SQLite
artifact storage
search/slicing/export
```

This establishes:

```text
persistent DevTools history
```

---

## Phase 3 — Inspector

Implement:

```text
DOM
CSS
highlight
element picker
DOM snapshot
accessibility
JS source search
```

This establishes:

```text
AI-accessible Elements inspector
```

---

## Phase 4 — Debugger

Implement:

```text
breakpoints
pause/resume
step
call frames
scopes
variables
evaluate-on-frame
DOM breakpoints
XHR breakpoints
event breakpoints
```

This establishes:

```text
AI-accessible Sources debugger
```

---

## Phase 5 — Storage

Implement:

```text
localStorage
sessionStorage
cookies
IndexedDB
Cache Storage
storage export
```

---

## Phase 6 — Profiling

Implement:

```text
CPU profiler
trace capture
heap snapshots
heap comparison
performance metrics
process monitoring
debug-session bundles
```

---

## Phase 7 — Test Simulation

Implement:

```text
clock control
time acceleration
timezone
CPU throttling
network simulation
fault injection
cache control
service worker bypass
device simulation
location
permissions
environment emulation
scenario presets
```

---

## Phase 8 — Desktop UX

Build:

```text
AI Browser.exe
```

with:

```text
profiles
running instances
start/stop browser
recording indicator
AI control indicator
pause AI button
MCP status
artifact browser
extension management
debug session controls
```

At this point the project behaves like a real developer browser product.

---

# 65. Final Product Mental Model

The final system is essentially:

```text
                  AI-NATIVE DEVELOPMENT BROWSER

┌─────────────────────────────────────────────────────┐
│                                                     │
│                    NORMAL BROWSER                   │
│                                                     │
│      browse normally / tabs / profiles / extensions │
│                                                     │
└───────────────────────┬─────────────────────────────┘
                        │
                       CDP
                        │
┌───────────────────────▼─────────────────────────────┐
│                       browserd                      │
│                                                     │
│ Browser automation                                  │
│ Visual screenshots                                  │
│ DOM inspector                                       │
│ CSS inspector                                       │
│ Accessibility                                       │
│ JavaScript runtime                                  │
│ Console                                             │
│ Debugger                                            │
│ Network DevTools                                    │
│ WebSockets                                          │
│ Storage                                             │
│ Memory / heap                                       │
│ CPU profiling                                       │
│ Performance tracing                                 │
│ Process monitoring                                  │
│ Clock manipulation                                  │
│ CPU/network throttling                              │
│ Device/environment emulation                        │
│ Fault injection                                     │
│ Test orchestration                                  │
│ Artifact storage                                    │
│ Persistent history                                  │
│                                                     │
└───────────────────────┬─────────────────────────────┘
                        │
                       MCP
                        │
┌───────────────────────▼─────────────────────────────┐
│                                                     │
│                        AI                           │
│                                                     │
│ sees                                                │
│ clicks                                              │
│ scrolls                                             │
│ inspects                                            │
│ debugs                                              │
│ profiles                                            │
│ modifies                                            │
│ tests                                               │
│ searches history                                    │
│ exports artifacts                                   │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## Core Principle

The browser is **not launched by the AI**.

The browser is its own persistent normal application.

I launch:

```text
AI Browser
```

and immediately:

```text
Chromium opens normally
+
browserd attaches
+
recording starts
+
instance registers itself
+
MCP endpoint remains available
```

I can then use the browser for as long as I want.

At **any point**, any authorized MCP client can discover:

```text
browser.list()
```

select:

```text
br_01
```

and immediately:

```text
see its tabs
take screenshots
navigate
click
type
scroll
inspect DOM
inspect CSS
highlight elements
run JavaScript
read console history
inspect exceptions
inspect every recorded network request
read headers
read payloads
read response bodies
search giant responses
export traffic
inspect WebSockets
inspect storage
modify storage
use JavaScript debugger
set breakpoints
inspect scopes
inspect variables
profile CPU
capture traces
take heap snapshots
analyze memory
change the clock
fast-forward time
change timezone
throttle CPU
slow/break network
simulate devices
simulate location
run automated tests
open real DevTools
or send arbitrary CDP commands
```

while the browser remains simultaneously usable by me.

That is the complete implementation target:

> **A persistent human-usable Chromium browser with an always-on DevTools/recording daemon behind it, exposing the entire debugging and automation environment to AI through MCP.**

# AI-Native Debug Browser — End-to-End Test Checklist

Use this after the whole system is built to verify that the browser, `browserd`, MCP layer, recording, debugging, profiling, automation, storage, artifacts, and simulation features all work together.

## 1. Installation & Startup

* [ ] Install the browser package on a clean machine.
* [ ] Launch `AI Browser.exe`, `.bat`, launcher, or tray menu.
* [ ] Confirm `browserd` starts automatically if not already running.
* [ ] Confirm only one daemon starts when launching multiple browsers.
* [ ] Confirm Chromium opens visibly in headed mode.
* [ ] Confirm the browser uses the intended persistent profile.
* [ ] Confirm browser history persists across restarts.
* [ ] Confirm cookies persist across restarts.
* [ ] Confirm saved logins persist across restarts.
* [ ] Confirm configured extensions load automatically.
* [ ] Confirm the browser receives a unique `browser_id`.
* [ ] Confirm a recording session starts immediately.
* [ ] Confirm CDP connection is established automatically.
* [ ] Confirm browserd shows browser status as `ready`.
* [ ] Confirm MCP endpoint starts automatically.
* [ ] Confirm browser remains fully usable without any MCP client connected.
* [ ] Confirm closing the browser marks the instance as stopped/disconnected.
* [ ] Confirm browserd remains healthy after a browser closes.
* [ ] Confirm another browser can be launched afterward.

## 2. Normal Human Browser Usage

* [ ] Open a website manually.
* [ ] Click links manually.
* [ ] Type into forms manually.
* [ ] Scroll manually.
* [ ] Open several tabs manually.
* [ ] Close tabs manually.
* [ ] Open a new browser window.
* [ ] Use back/forward manually.
* [ ] Reload pages manually.
* [ ] Log into a test website manually.
* [ ] Confirm normal browsing is not noticeably broken by instrumentation.
* [ ] Confirm browserd records activity performed entirely by the human.

## 3. Fresh MCP Discovery

Test this with an AI/MCP client that was **not connected when the browser started**.

* [ ] Start the browser.
* [ ] Browse manually for several minutes.
* [ ] Trigger network requests.
* [ ] Trigger console logs.
* [ ] Trigger an application error.
* [ ] Only now start a fresh MCP client.
* [ ] Call `browser.list()`.
* [ ] Confirm the running browser appears.
* [ ] Confirm its `browser_id` is correct.
* [ ] Confirm current recording session is discoverable.
* [ ] Call `tabs.list(browser_id)`.
* [ ] Confirm all current tabs are visible.
* [ ] Query previous network requests.
* [ ] Query previous console logs.
* [ ] Confirm events generated before MCP connected are available.
* [ ] Disconnect MCP.
* [ ] Continue browsing.
* [ ] Connect a completely new MCP session.
* [ ] Confirm the newer activity is also available.

## 4. Multiple Browser Instances

* [ ] Launch Browser A.
* [ ] Launch Browser B.
* [ ] Launch Browser C.
* [ ] Confirm each gets a different `browser_id`.
* [ ] Confirm each uses the correct profile.
* [ ] Open different websites in each browser.
* [ ] Call `browser.list()`.
* [ ] Confirm all three instances appear.
* [ ] Query Browser A network records only.
* [ ] Confirm Browser B/C data does not leak into results.
* [ ] Control Browser B.
* [ ] Confirm Browser A/C are unaffected.
* [ ] Close Browser B.
* [ ] Confirm Browser A/C remain usable.
* [ ] Confirm Browser B changes state to stopped.
* [ ] Confirm Browser B's historical recording remains readable.

## 5. Tab & Target Discovery

* [ ] Open multiple tabs.
* [ ] Open pages containing iframes.
* [ ] Open pages that create Web Workers.
* [ ] Trigger a Service Worker.
* [ ] Load a browser extension with a service worker if applicable.
* [ ] Verify page targets are discovered.
* [ ] Verify iframe targets are discovered.
* [ ] Verify worker targets are discovered.
* [ ] Verify service-worker targets are discovered.
* [ ] Verify targets disappearing are removed/marked correctly.
* [ ] Verify new targets auto-attach.
* [ ] Confirm target → session mapping is correct.
* [ ] Confirm activity in workers is recorded.

## 6. Screenshots & Vision

* [ ] Request viewport screenshot.
* [ ] Confirm the returned image matches the selected tab.
* [ ] Request full-page screenshot.
* [ ] Confirm content below the fold is captured.
* [ ] Request screenshot of a specific element.
* [ ] Confirm screenshot is returned to the AI as image content.
* [ ] Confirm screenshot is also saved as an artifact.
* [ ] Confirm screenshot metadata contains browser/tab/timestamp.
* [ ] Navigate and take another screenshot.
* [ ] Confirm old and new screenshots remain separately available.
* [ ] Verify screenshots from different browsers are correctly isolated.

## 7. Navigation & Human-Like Automation

* [ ] Navigate to a URL.
* [ ] Click a button by selector.
* [ ] Click using accessible role/name.
* [ ] Double-click an element.
* [ ] Hover over an element.
* [ ] Fill an input.
* [ ] Type character-by-character.
* [ ] Press Enter.
* [ ] Press keyboard shortcuts.
* [ ] Scroll down.
* [ ] Scroll up.
* [ ] Scroll a nested scrollable container.
* [ ] Scroll an element into view.
* [ ] Drag and drop.
* [ ] Open a new tab.
* [ ] Switch tabs.
* [ ] Close a tab.
* [ ] Use Back.
* [ ] Use Forward.
* [ ] Reload.
* [ ] Wait for an element.
* [ ] Wait for navigation.
* [ ] Verify AI interaction remains visible in the headed browser.

## 8. Human + AI Shared Control

* [ ] Set mode to `observe`.
* [ ] Confirm AI can inspect but cannot click/type/change state.
* [ ] Set mode to `shared`.
* [ ] Confirm human and AI can both interact.
* [ ] Set mode to `agent`.
* [ ] Confirm agent interaction is enabled.
* [ ] Set mode to `paused`.
* [ ] Confirm mutating AI actions are rejected.
* [ ] Press emergency/manual `Pause AI` control.
* [ ] Confirm control stops immediately.
* [ ] Resume control.
* [ ] Confirm read-only inspection remains available where intended.

## 9. DOM Inspection

* [ ] Query an element by CSS selector.
* [ ] Query multiple elements.
* [ ] Read element text.
* [ ] Read attributes.
* [ ] Read `outerHTML`.
* [ ] Read children.
* [ ] Read parent.
* [ ] Read bounding box.
* [ ] Inspect a deeply nested element.
* [ ] Inspect an element inside an iframe.
* [ ] Inspect an element inside Shadow DOM.
* [ ] Modify an attribute.
* [ ] Remove an attribute.
* [ ] Modify text.
* [ ] Modify HTML.
* [ ] Remove a node.
* [ ] Confirm changes visibly affect the page.
* [ ] Export a large DOM tree as an artifact.
* [ ] Read only a slice of the exported DOM artifact.

## 10. Element Highlighting & Picker

* [ ] Call `inspector.highlight(node)`.
* [ ] Confirm the correct element is visibly highlighted.
* [ ] Highlight an element inside an iframe.
* [ ] Remove highlighting.
* [ ] Start element-picker mode.
* [ ] Hover over elements manually.
* [ ] Confirm hover highlighting works.
* [ ] Click a selected element.
* [ ] Confirm browserd returns a stable node handle.
* [ ] Inspect the selected node through MCP.
* [ ] Screenshot the highlighted element.
* [ ] Confirm AI can visually correlate the highlight with DOM data.

## 11. CSS Inspector

* [ ] Read computed styles.
* [ ] Read inline styles.
* [ ] Read matched stylesheet rules.
* [ ] Verify selector/source filename/line information.
* [ ] Inspect inherited styles.
* [ ] Inspect pseudo-element styles.
* [ ] Inspect CSS variables.
* [ ] Inspect `display`.
* [ ] Inspect `visibility`.
* [ ] Inspect `opacity`.
* [ ] Inspect `overflow`.
* [ ] Inspect `position`.
* [ ] Inspect `z-index`.
* [ ] Inspect transforms.
* [ ] Modify an inline style.
* [ ] Modify a stylesheet rule.
* [ ] Confirm visual change.
* [ ] Restore the original style.
* [ ] Export large stylesheet source as an artifact.

## 12. Accessibility

* [ ] Capture accessibility snapshot.
* [ ] Verify roles.
* [ ] Verify accessible names.
* [ ] Verify labels.
* [ ] Verify disabled states.
* [ ] Verify expanded/collapsed states.
* [ ] Verify focused element.
* [ ] Compare accessibility tree before/after interaction.
* [ ] Detect an intentionally unlabeled form control.

## 13. Console Logging

Create a test page that emits all log types.

* [ ] Capture `console.log`.
* [ ] Capture `console.info`.
* [ ] Capture `console.warn`.
* [ ] Capture `console.error`.
* [ ] Capture `console.debug`.
* [ ] Capture objects passed as console arguments.
* [ ] Capture stack traces.
* [ ] Capture source URL.
* [ ] Capture source line/column.
* [ ] Capture timestamps.
* [ ] Capture logs from iframes.
* [ ] Capture logs from workers where supported.
* [ ] Capture uncaught exceptions.
* [ ] Capture rejected promises.
* [ ] Query console by level.
* [ ] Query by text search.
* [ ] Query by start/end time.
* [ ] Query by tab.
* [ ] Paginate through thousands of logs.
* [ ] Export logs to NDJSON.
* [ ] Read a range from exported logs.
* [ ] Verify logs generated before MCP connected remain queryable.

## 14. Console / Runtime Execution

* [ ] Execute `1 + 1`.
* [ ] Read `document.title`.
* [ ] Inspect `window.location`.
* [ ] Query DOM through executed JavaScript.
* [ ] Return a JSON object.
* [ ] Return an array.
* [ ] Return a complex object handle.
* [ ] Inspect properties of that object.
* [ ] Invoke a function on that object.
* [ ] Execute code in a chosen frame.
* [ ] Execute code in a paused debugger frame.
* [ ] Release object handles.
* [ ] Confirm browserd does not leak handles indefinitely.

## 15. Network Request Recording

Use a test application that performs GET/POST/PUT/DELETE requests.

* [ ] Capture GET request.
* [ ] Capture POST request.
* [ ] Capture PUT request.
* [ ] Capture DELETE request.
* [ ] Capture URL.
* [ ] Capture HTTP method.
* [ ] Capture request headers.
* [ ] Capture transmitted extra headers where available.
* [ ] Capture cookies.
* [ ] Capture request body.
* [ ] Capture JSON payload.
* [ ] Capture form-urlencoded payload.
* [ ] Test multipart upload behavior.
* [ ] Capture response status.
* [ ] Capture response headers.
* [ ] Capture response cookies.
* [ ] Capture response body.
* [ ] Capture MIME type.
* [ ] Capture protocol.
* [ ] Capture timing information.
* [ ] Capture remote IP where available.
* [ ] Capture initiator.
* [ ] Capture initiator stack.
* [ ] Capture redirect chain.
* [ ] Capture failed request reason.
* [ ] Capture cache information.
* [ ] Capture service-worker involvement.
* [ ] Confirm records remain available after navigation.
* [ ] Confirm records remain available after tab closes.

## 16. Large Network Responses

* [ ] Request a 1 MB JSON response.
* [ ] Request a 10 MB JSON response.
* [ ] Request a 100+ MB response if practical.
* [ ] Confirm browserd does not inject the entire response into MCP.
* [ ] Confirm response is written to an artifact.
* [ ] Check `artifact.stat`.
* [ ] Read first 64 KB.
* [ ] Read a middle range.
* [ ] Search for a known string.
* [ ] Query a known JSON path.
* [ ] Confirm memory usage remains reasonable.
* [ ] Confirm incomplete/cancelled downloads are handled safely.

## 17. Network Export

* [ ] Export a single request.
* [ ] Export a selected time range.
* [ ] Export a selected tab.
* [ ] Export HAR.
* [ ] Export JSON.
* [ ] Export NDJSON.
* [ ] Confirm request bodies are represented.
* [ ] Confirm response bodies/resources are represented as intended.
* [ ] Open the HAR in another HAR-compatible tool.
* [ ] Confirm it parses correctly.
* [ ] Confirm exported files receive artifact IDs.
* [ ] Confirm returned filesystem paths exist.

## 18. WebSocket Debugging

* [ ] Connect to a WebSocket endpoint.
* [ ] Record handshake.
* [ ] Record sent frames.
* [ ] Record received frames.
* [ ] Record text frames.
* [ ] Record binary-frame metadata/artifacts.
* [ ] Query frames by time.
* [ ] Query frames by content.
* [ ] Export WebSocket conversation.
* [ ] Verify WebSocket records remain after disconnect.

## 19. Local Storage

* [ ] List localStorage.
* [ ] Read a key.
* [ ] Set a key.
* [ ] Reload page and confirm change.
* [ ] Delete a key.
* [ ] Clear localStorage.
* [ ] Verify origin isolation.

## 20. Session Storage

* [ ] List sessionStorage.
* [ ] Read a key.
* [ ] Set a key.
* [ ] Delete a key.
* [ ] Clear sessionStorage.
* [ ] Confirm tab/session isolation works as expected.
* [ ] Confirm correct behavior after navigation.

## 21. Cookies

* [ ] List cookies.
* [ ] Inspect domain/path/secure/HTTPOnly/SameSite.
* [ ] Set a test cookie.
* [ ] Delete a cookie.
* [ ] Clear cookies for a site.
* [ ] Confirm cookie modification affects subsequent requests.
* [ ] Confirm HTTPOnly handling is correctly represented.

## 22. IndexedDB

* [ ] List databases.
* [ ] Describe object stores.
* [ ] List indexes.
* [ ] Query records.
* [ ] Paginate through a large object store.
* [ ] Insert/update a record through the browser-side fallback.
* [ ] Verify application sees the changed record.
* [ ] Delete a record.
* [ ] Clear an object store.
* [ ] Export database contents.
* [ ] Inspect exported content through artifacts.

## 23. Cache Storage

* [ ] List caches.
* [ ] List cache entries.
* [ ] Read cached response metadata.
* [ ] Read cached response body.
* [ ] Delete a cached entry.
* [ ] Clear a cache.
* [ ] Confirm application behavior changes appropriately.

## 24. JavaScript Sources

* [ ] List loaded scripts.
* [ ] Retrieve small script source.
* [ ] Search loaded scripts for a known string.
* [ ] Find matching filename/line.
* [ ] Read selected source range.
* [ ] Search minified bundle.
* [ ] Search source-mapped code where available.
* [ ] Export large source file as an artifact.
* [ ] Verify source search does not dump entire bundles into model context.

## 25. JavaScript Debugger

Create a deterministic test script.

* [ ] Enable debugger.
* [ ] Set breakpoint by URL/line.
* [ ] Trigger breakpoint.
* [ ] Confirm debugger reports paused state.
* [ ] Read call stack.
* [ ] Read local scope.
* [ ] Read closure scope.
* [ ] Read global scope.
* [ ] Inspect variables.
* [ ] Inspect nested object variables.
* [ ] Evaluate expression in selected frame.
* [ ] Change a local variable.
* [ ] Resume execution.
* [ ] Confirm modified variable changes behavior.
* [ ] Step over.
* [ ] Step into.
* [ ] Step out.
* [ ] Pause manually.
* [ ] Resume manually.
* [ ] Pause on uncaught exceptions.
* [ ] Pause on all exceptions.
* [ ] Remove breakpoint.
* [ ] Confirm debugger remains scoped to intended target.

## 26. DOM/Event/XHR Breakpoints

* [ ] Break when subtree changes.
* [ ] Break when attribute changes.
* [ ] Break when node is removed.
* [ ] Trigger each condition.
* [ ] Confirm responsible JavaScript frame is reported.
* [ ] Break on a click event.
* [ ] Break on an XHR/fetch matching a URL.
* [ ] Trigger matching request.
* [ ] Confirm debugger pauses correctly.

## 27. Real DevTools Window

* [ ] Open DevTools Elements panel.
* [ ] Open Console panel.
* [ ] Open Network panel.
* [ ] Open Sources panel.
* [ ] Open Performance/timeline panel.
* [ ] Open heap-profiler panel.
* [ ] Confirm DevTools targets the intended page.
* [ ] Confirm opening DevTools does not disrupt browserd recording.
* [ ] Confirm multiple browser instances open their own correct DevTools.

## 28. Heap Snapshot

* [ ] Take baseline heap snapshot.
* [ ] Confirm snapshot streams to disk.
* [ ] Confirm browserd remains responsive while snapshot is taken.
* [ ] Perform memory-heavy operation.
* [ ] Take second snapshot.
* [ ] Compare snapshots.
* [ ] Verify constructor/object count differences.
* [ ] Verify size differences.
* [ ] Detect intentionally retained objects.
* [ ] Detect detached DOM nodes where possible.
* [ ] Export summary.
* [ ] Confirm full heap file is not sent into LLM context.

## 29. Heap Sampling / Allocation Tracking

* [ ] Start heap sampling.
* [ ] Perform test workload.
* [ ] Stop sampling.
* [ ] Retrieve allocation profile.
* [ ] Verify stack attribution.
* [ ] Start object tracking.
* [ ] Generate allocations.
* [ ] Stop tracking.
* [ ] Call explicit garbage collection where supported.
* [ ] Confirm retained allocation behavior is analyzable.

## 30. Native/Browser Memory Metrics

* [ ] Read DOM counters.
* [ ] Read browser/renderer memory metrics.
* [ ] Start native allocation sampling.
* [ ] Run workload.
* [ ] Stop sampling.
* [ ] Verify profile data.
* [ ] Prepare leak-detection mode.
* [ ] Verify unsupported raw-memory operations are rejected clearly.

## 31. CPU Profiling

* [ ] Start CPU profile.
* [ ] Run CPU-heavy page code.
* [ ] Stop profile.
* [ ] Confirm `.cpuprofile` artifact is generated.
* [ ] Calculate top functions.
* [ ] Calculate percentage CPU per function.
* [ ] Verify intentionally expensive function ranks near top.
* [ ] Export summary.
* [ ] Open profile in compatible DevTools tooling if desired.

## 32. Performance Tracing

* [ ] Start trace.
* [ ] Perform navigation.
* [ ] Perform heavy interaction.
* [ ] Stop trace.
* [ ] Confirm trace is streamed to artifact storage.
* [ ] Identify long tasks.
* [ ] Identify layout work.
* [ ] Identify scripting work.
* [ ] Identify rendering/painting work where available.
* [ ] Correlate trace timestamps with network/console timeline.
* [ ] Confirm very large trace does not overwhelm MCP.

## 33. Continuous Performance Metrics

* [ ] Record metrics while idle.
* [ ] Record metrics during heavy activity.
* [ ] Query by time range.
* [ ] Verify JS heap metrics.
* [ ] Verify DOM node counts.
* [ ] Verify event-listener counts where available.
* [ ] Verify script duration.
* [ ] Verify layout/style duration.
* [ ] Verify relevant web-vital/timeline metrics.
* [ ] Compare two time ranges.

## 34. Chromium Process Monitoring

* [ ] Detect browser process.
* [ ] Detect renderer processes.
* [ ] Detect GPU process.
* [ ] Detect utility processes.
* [ ] Correlate renderer with tabs/targets where possible.
* [ ] Record CPU usage.
* [ ] Record RSS/memory.
* [ ] Record process exit.
* [ ] Kill a test renderer.
* [ ] Confirm browserd records crash/disconnect properly.

## 35. Clock Control

Use a page with `Date.now`, timers, intervals, animation frames.

* [ ] Install fake clock.
* [ ] Set known date/time.
* [ ] Verify `Date.now()`.
* [ ] Verify `new Date()`.
* [ ] Verify `performance.now()` behavior as intended.
* [ ] Verify `setTimeout`.
* [ ] Verify `setInterval`.
* [ ] Verify `requestAnimationFrame`.
* [ ] Run time forward 5 minutes.
* [ ] Confirm due timers execute.
* [ ] Jump time forward 5 minutes.
* [ ] Confirm jump semantics differ appropriately.
* [ ] Freeze time.
* [ ] Verify wall clock stays frozen.
* [ ] Resume clock.
* [ ] Test midnight rollover.
* [ ] Test month rollover.
* [ ] Test year rollover.
* [ ] Test expiry logic.
* [ ] Reset clock to normal.

## 36. Timezone Emulation

* [ ] Set `Asia/Kolkata`.
* [ ] Verify page timezone.
* [ ] Set `America/New_York`.
* [ ] Verify page timezone.
* [ ] Set `Europe/London`.
* [ ] Test date formatting.
* [ ] Test DST-sensitive application behavior.
* [ ] Reset timezone.

## 37. CPU Throttling

* [ ] Run workload with CPU rate 1×.
* [ ] Record baseline performance.
* [ ] Set 2× slowdown.
* [ ] Repeat workload.
* [ ] Set 4× slowdown.
* [ ] Repeat workload.
* [ ] Set 6× slowdown.
* [ ] Repeat workload.
* [ ] Confirm measured durations increase meaningfully.
* [ ] Reset throttling.
* [ ] Confirm browser returns to normal.

## 38. Network Simulation

* [ ] Set increased latency.
* [ ] Confirm network timing reflects delay.
* [ ] Limit download throughput.
* [ ] Limit upload throughput.
* [ ] Apply slow-network preset.
* [ ] Test offline mode.
* [ ] Confirm `navigator.onLine` behavior if intended.
* [ ] Restore normal network.
* [ ] Confirm network recorder captures simulated conditions.

## 39. Network Fault Injection

* [ ] Delay matching request.
* [ ] Abort matching request.
* [ ] Replace response body.
* [ ] Change status to 500.
* [ ] Return malformed JSON.
* [ ] Drop only the next matching request.
* [ ] Apply rule to only one URL pattern.
* [ ] Confirm unrelated requests are unaffected.
* [ ] Remove fault.
* [ ] Confirm normal behavior resumes.
* [ ] Confirm injected faults are logged in unified timeline.

## 40. Cache & Service Worker Testing

* [ ] Disable browser cache.
* [ ] Reload.
* [ ] Verify resources reload.
* [ ] Enable cache.
* [ ] Clear cache.
* [ ] Bypass Service Worker.
* [ ] Reload.
* [ ] Confirm request path changes.
* [ ] Restore Service Worker.
* [ ] Confirm state restoration.

## 41. Device Emulation

* [ ] Desktop viewport.
* [ ] Mobile viewport.
* [ ] Tablet viewport.
* [ ] Custom width/height.
* [ ] Custom DPR.
* [ ] Portrait orientation.
* [ ] Landscape orientation.
* [ ] Touch enabled.
* [ ] Take screenshots at each size.
* [ ] Confirm responsive layout changes.
* [ ] Inspect CSS media-rule effects.

## 42. Geolocation

* [ ] Set known latitude/longitude.
* [ ] Verify application receives it.
* [ ] Change location.
* [ ] Verify application updates.
* [ ] Simulate unavailable geolocation.
* [ ] Reset location.

## 43. Permissions

* [ ] Grant test permission.
* [ ] Confirm page sees permission.
* [ ] Deny permission.
* [ ] Confirm failure path.
* [ ] Reset permission.
* [ ] Repeat for supported permissions such as geolocation/notifications/clipboard.
* [ ] Confirm permissions are scoped correctly.

## 44. Environmental Emulation

* [ ] Set dark color scheme.
* [ ] Verify CSS/media behavior.
* [ ] Set light color scheme.
* [ ] Enable reduced motion.
* [ ] Verify animations adapt.
* [ ] Emulate supported vision deficiency.
* [ ] Take screenshot.
* [ ] Reset environment.

## 45. Idle / User State Simulation

* [ ] Simulate active user.
* [ ] Simulate idle user.
* [ ] Verify application behavior.
* [ ] Simulate locked state where supported.
* [ ] Restore active/unlocked state.

## 46. Sensor Emulation

If implemented:

* [ ] Simulate accelerometer.
* [ ] Simulate gyroscope.
* [ ] Simulate orientation.
* [ ] Simulate ambient light.
* [ ] Confirm application receives test values.
* [ ] Reset sensors.

## 47. Scenario Presets

* [ ] Apply `slow-mobile`.
* [ ] Verify expected viewport/network/CPU settings.
* [ ] Apply `terrible-network`.
* [ ] Verify expected network settings.
* [ ] Apply `offline`.
* [ ] Verify browser behavior.
* [ ] Apply `slow-cpu`.
* [ ] Verify CPU rate.
* [ ] Apply `memory-leak` instrumentation preset.
* [ ] Reset scenario.
* [ ] Confirm all changed environment state is restored.

## 48. Automated Test Orchestration

* [ ] Start `test.begin`.
* [ ] Perform page actions.
* [ ] Create checkpoint.
* [ ] Record assertion.
* [ ] Perform simulated-time action.
* [ ] Record another assertion.
* [ ] End test.
* [ ] Confirm test manifest is stored.
* [ ] Confirm network logs are linked.
* [ ] Confirm console logs are linked.
* [ ] Confirm screenshots are linked.
* [ ] Confirm test timeline is ordered correctly.
* [ ] Confirm failure produces useful diagnostics.

## 49. Unified Timeline

Generate events from many systems close together.

* [ ] Start test session.
* [ ] Click an element.
* [ ] Trigger request.
* [ ] Trigger console warning.
* [ ] Trigger DOM update.
* [ ] Trigger network fault.
* [ ] Take screenshot.
* [ ] Trigger debugger pause.
* [ ] Resume.
* [ ] Stop test.
* [ ] Query unified timeline.
* [ ] Confirm timestamps are comparable.
* [ ] Confirm ordering is correct.
* [ ] Confirm each event links to its underlying artifact/record.

## 50. Artifact System

* [ ] Store screenshot artifact.
* [ ] Store network body artifact.
* [ ] Store HAR artifact.
* [ ] Store console export.
* [ ] Store trace.
* [ ] Store CPU profile.
* [ ] Store heap snapshot.
* [ ] Store DOM snapshot.
* [ ] Call `artifact.stat`.
* [ ] Read full small artifact.
* [ ] Read byte range from large artifact.
* [ ] Read line range.
* [ ] Search artifact.
* [ ] Query JSON artifact.
* [ ] Export/copy artifact.
* [ ] Verify invalid artifact IDs fail cleanly.
* [ ] Verify deleted artifacts are handled cleanly.
* [ ] Verify paths cannot escape the configured artifact directory.

## 51. Historical Sessions

* [ ] Record Browser Session A.
* [ ] Close browser.
* [ ] Restart browserd.
* [ ] Connect fresh MCP client.
* [ ] List historical recording sessions.
* [ ] Query Session A network records.
* [ ] Query Session A console records.
* [ ] Open Session A screenshots.
* [ ] Open Session A traces.
* [ ] Confirm live operations on the dead session are rejected clearly.
* [ ] Confirm historical data survives daemon restart.
* [ ] Restart machine if practical.
* [ ] Confirm historical sessions still exist afterward.

## 52. Browserd Crash Recovery

* [ ] Start browser and recording.
* [ ] Force-kill browserd.
* [ ] Confirm browser itself remains usable if designed that way.
* [ ] Restart browserd.
* [ ] Confirm it recovers persisted metadata.
* [ ] Confirm it can reconnect to running browsers where supported.
* [ ] Confirm new recording data works.
* [ ] Confirm partially written artifacts are handled safely.

## 53. Browser Crash Recovery

* [ ] Start browser.
* [ ] Force-kill Chromium.
* [ ] Confirm browserd detects disconnect.
* [ ] Confirm recording session is finalized.
* [ ] Confirm stored network/console data remains readable.
* [ ] Relaunch browser.
* [ ] Confirm a new live instance/session starts cleanly.

## 54. Multiple MCP Clients

* [ ] Connect MCP Client A.
* [ ] Connect MCP Client B.
* [ ] Both call `browser.list()`.
* [ ] Both read network history.
* [ ] Client A controls Browser A.
* [ ] Client B inspects Browser A simultaneously.
* [ ] Confirm no data corruption.
* [ ] Confirm operations have client/request IDs in audit logs.
* [ ] Test simultaneous mutating calls.
* [ ] Verify locking/control policy works.

## 55. Raw CDP Escape Hatch

* [ ] Call a harmless CDP command.
* [ ] Confirm result is returned correctly.
* [ ] Call target-specific CDP method.
* [ ] Confirm correct session is selected.
* [ ] Request unknown CDP method.
* [ ] Confirm useful error returned.
* [ ] Send invalid parameters.
* [ ] Confirm browserd remains healthy.
* [ ] Confirm restricted commands follow configured security policy.

## 56. Extension Integration

* [ ] Launch browser with extension enabled.
* [ ] Confirm extension UI works.
* [ ] Confirm extension service worker is discoverable where expected.
* [ ] Confirm extension logs are capturable if intended.
* [ ] Confirm extension does not break CDP recording.
* [ ] Restart browser and verify extension persists.
* [ ] Test multiple custom extensions.

## 57. Security & Isolation

* [ ] Confirm MCP binds only to intended local interface by default.
* [ ] Confirm unauthorized remote clients cannot connect.
* [ ] Verify MCP authentication if implemented.
* [ ] Verify browser IDs cannot access another user's daemon.
* [ ] Verify filesystem paths are sanitized.
* [ ] Verify artifact path traversal is blocked.
* [ ] Verify arbitrary file reads outside artifact store are blocked unless explicitly designed.
* [ ] Verify browser profiles are isolated.
* [ ] Verify Browser A storage cannot be accidentally modified through Browser B handle.
* [ ] Verify raw CDP commands are permission-controlled.
* [ ] Verify mutating commands can be disabled in observe mode.
* [ ] Verify network logs containing secrets are treated as sensitive data.
* [ ] Verify an option exists to redact/export safely where required.
* [ ] Verify audit log captures AI mutations.

## 58. Resource & Stability Testing

* [ ] Browse for 1 hour.
* [ ] Browse for several hours.
* [ ] Generate 10,000 network requests.
* [ ] Generate 100,000 console messages.
* [ ] Open 50+ tabs if machine permits.
* [ ] Repeatedly create/destroy workers.
* [ ] Record large response bodies.
* [ ] Monitor browserd RAM usage.
* [ ] Monitor browserd CPU usage.
* [ ] Confirm SQLite remains responsive.
* [ ] Confirm log querying stays usable.
* [ ] Confirm storage rotation/retention policy works.
* [ ] Confirm object handles are released.
* [ ] Confirm CDP sessions are removed when targets disappear.
* [ ] Confirm no obvious long-running memory leak.

## 59. Query Performance

Populate a large test recording.

* [ ] Search 100,000 network records.
* [ ] Filter by URL.
* [ ] Filter by status.
* [ ] Filter by method.
* [ ] Filter by MIME type.
* [ ] Filter by time.
* [ ] Search 100,000 console records.
* [ ] Paginate results.
* [ ] Query artifacts.
* [ ] Confirm useful indexes exist.
* [ ] Confirm responses remain AI-sized.
* [ ] Confirm huge datasets never automatically enter MCP response bodies.

## 60. Complete Autonomous Debugging Test

Create an intentionally broken application with:

```text
frontend visual bug
console error
failed API request
incorrect payload
large JSON response
storage state
slow function
small memory leak
```

Then tell a fresh AI session only:

```text
"Something is wrong with this app. Find the problems."
```

Verify the AI can independently:

* [ ] Discover the browser.
* [ ] Discover the correct tab.
* [ ] Take screenshot.
* [ ] Visually identify suspicious UI.
* [ ] Inspect relevant DOM.
* [ ] Inspect CSS.
* [ ] Highlight the element.
* [ ] Read console errors.
* [ ] Find failed network request.
* [ ] Read request headers.
* [ ] Read request payload.
* [ ] Read response headers.
* [ ] Read response body.
* [ ] Search large response through artifact tools.
* [ ] Find JavaScript source involved.
* [ ] Set breakpoint.
* [ ] Reproduce problem.
* [ ] Inspect variables.
* [ ] Inspect session/local storage.
* [ ] Profile slow behavior.
* [ ] Identify memory increase if included.
* [ ] Explain root cause with evidence from the browser.

If this works, the central product concept works.

## 61. Complete Automated Testing Test

Ask the AI:

```text
"Test this checkout page under bad conditions."
```

Verify it can autonomously:

* [ ] Apply mobile viewport.
* [ ] Apply CPU throttling.
* [ ] Apply slow network.
* [ ] Navigate through checkout.
* [ ] Inject a delayed API response.
* [ ] Inject an HTTP 500 response.
* [ ] Simulate offline mode.
* [ ] Restore online mode.
* [ ] Manipulate clock to test expiration.
* [ ] Test another timezone.
* [ ] Take screenshots after important steps.
* [ ] Inspect console failures.
* [ ] Inspect network failures.
* [ ] Inspect DOM state.
* [ ] Create performance trace.
* [ ] Produce an evidence-backed test result.

## 62. Final Acceptance Test

The system is ready when this entire scenario works:

* [ ] Launch the special browser like a normal browser.
* [ ] Do not connect any AI.
* [ ] Browse manually.
* [ ] Open multiple tabs.
* [ ] Trigger application activity.
* [ ] Let browserd continuously record everything.
* [ ] Later open a completely fresh AI/MCP session.
* [ ] AI discovers the already-running browser.
* [ ] AI sees all open tabs.
* [ ] AI can screenshot any tab.
* [ ] AI can visually inspect the page.
* [ ] AI can navigate/click/type/scroll.
* [ ] AI can inspect HTML/DOM.
* [ ] AI can inspect and modify CSS.
* [ ] AI can highlight/pick elements.
* [ ] AI can read historical console logs.
* [ ] AI can execute JavaScript.
* [ ] AI can inspect every captured network request.
* [ ] AI can see request headers.
* [ ] AI can see payloads.
* [ ] AI can see response headers.
* [ ] AI can retrieve response bodies.
* [ ] AI can search/export huge responses instead of loading them all.
* [ ] AI can inspect WebSockets.
* [ ] AI can read/edit storage.
* [ ] AI can use JavaScript debugger.
* [ ] AI can inspect scopes and variables.
* [ ] AI can use DOM/event/XHR breakpoints.
* [ ] AI can take heap snapshots.
* [ ] AI can profile CPU.
* [ ] AI can capture performance traces.
* [ ] AI can inspect process/memory footprint.
* [ ] AI can control browser time.
* [ ] AI can fast-forward timers.
* [ ] AI can change timezone.
* [ ] AI can throttle CPU.
* [ ] AI can throttle/break the network.
* [ ] AI can emulate devices.
* [ ] AI can simulate location/environment.
* [ ] AI can run test scenarios.
* [ ] AI can save large debugging data as artifacts.
* [ ] Another fresh MCP session can later inspect the same recorded history.
* [ ] Browser remains usable by the human throughout.

If all of those pass, you have successfully built the intended system:

**a persistent human-usable browser with always-on DevTools-grade recording, full automation/debugging/profiling/testing capabilities, and an MCP interface that any fresh authorized AI session can discover and use at any time.**
