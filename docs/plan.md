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
