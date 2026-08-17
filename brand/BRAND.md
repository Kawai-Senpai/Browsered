<div align="center">
  <img src="logo.svg" alt="browserd" width="400">
</div>

# Brand

## Name

**browserd.** Lowercase, always — it is a daemon, and daemons are lowercase
(`sshd`, `httpd`, `containerd`). Never "BrowserD", never "Browser Daemon". The
trailing `d` is the whole joke and the whole promise: this thing is already
running.

The npm package is `agent-browser`; the product, the binary and the MCP server
name are `browserd`.

## Voice

browserd is **infrastructure**, not an assistant. It reports, it does not
reassure. The tone is a daemon's log line: present tense, specific, and quiet
about things that went normally.

| Do | Don't |
| --- | --- |
| "14 requests, 17KB, slowest 2813ms" | "Captured lots of network activity!" |
| "Recording started before the first page script ran." | "Never miss a request again!" |
| "Body exceeded the capture limit; raise recorder.maxBodyBytes." | "Something went wrong." |
| "Branded Chrome cannot sideload extensions." | "Oops! Extension failed 😔" |

Three rules:

1. **Say the number.** An observability tool that says "several" has failed.
2. **Name the limit.** Every answer says what it does not cover — which buffer
   truncated, which body was skipped, when recording began.
3. **Never promise completeness you cannot keep.** "Every request Chromium
   reported" is honest. "Every byte on the wire" is not, and NetLog is a
   separate flag for a reason.

## Colour

A terminal palette. The surface is always dark, because the daemon's natural
habitat is a terminal beside the browser it is watching.

| Token | Hex | Means |
| --- | --- | --- |
| `--wire` | `#26C08A` | The recording is live. Signal, a confirmed fact |
| `--amber` | `#D99A2B` | A number worth reading: timing, size, count |
| `--alert` | `#D9534F` | A failure the page actually suffered |
| `--surface-0` | `#16181C` | The field |
| `--surface-1` | `#1E2126` | A raised surface |
| `--surface-2` | `#262A30` | The surface above that |
| `--line` | `#31363E` | Structure |
| `--text` | `#DDE1E6` | Primary type |
| `--text-dim` | `#8A9199` | Labels, secondary type |

Accents are **desaturated on purpose**. A pure `#00E5A0` on near-black is a
neon sign; this is a tool that sits open for hours. Every accent is muted to
roughly the weight of Material's 400-level tones so it reads as ink on a matte
surface rather than as light behind glass.

Green means *the tape is rolling*. It is the one colour that appears in every
piece of artwork, because continuous recording is the entire product.

Amber is for magnitudes, never for warnings — a 2813ms request is not an error,
it is a fact you need to see. Red is reserved for something that genuinely
failed: a 500, a refused connection, an uncaught exception.

## Mark

Three horizontal traces of unequal length, left-aligned, with a filled dot at
the head of the middle one: an event stream still being written, and the cursor
that is writing it.

- Geometry: [`mark.svg`](mark.svg) · lockup: [`logo.svg`](logo.svg) · social:
  [`banner.svg`](banner.svg) · flow: [`flow.svg`](flow.svg)
- The traces are `--text-dim`; the live one and its cursor are `--wire`. Never
  all three the same colour — the point is that one of them is still moving.
- Clear space: one trace-height on all sides.

## Type

- Interface and display: `ui-monospace, SFMono-Regular, Menlo, Consolas` for
  everything. A daemon has no display face; its output is monospace, so its
  identity is too.
- The only exception is long prose in the README, which uses the reader's
  default sans.
- Numbers are always monospace and always right-aligned when compared to other
  numbers.

## Form

- **Flat and matte. No gradients anywhere** — not on the field, not on the mark,
  not behind the logo. Depth comes from stepping `--surface-0` → `--surface-1` →
  `--surface-2`, the way Material separates planes by elevation rather than by
  glow.
- Hairline borders (`1px`) in `--line`. This is a scope, not a poster.
- No background grids, scanlines or texture. An empty surface is allowed to be
  empty.
- Square corners (`2px` at most) everywhere except status pills.
- No shadows. If two things need separating, change the surface tone.

## Tagline

> **record first · query later**

Lowercase, monospace, middot separator. The longer positioning line:

> A continuously-recording Chromium with programmable DevTools, exposed to AI
> over MCP.

Never pitch it as browser automation. The automation is the least interesting
thing it does.

---

<sub>Design and engineering by
<a href="https://ranitbhowmick.com"><b>Ranit Bhowmick</b></a>.</sub>
