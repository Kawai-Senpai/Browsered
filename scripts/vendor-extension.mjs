#!/usr/bin/env node
/**
 * Vendor the Context Capsule extension into browserd.
 *
 *   node scripts/vendor-extension.mjs [--source <dir>] [--check]
 *
 * browserd launches a real headed Chromium that a human uses, so the visual
 * capture panel is genuinely useful there. But browserd already *is* the agent
 * interface: it records network, console and DOM itself and exposes them over
 * MCP. Shipping the extension's own native-messaging/MCP export path alongside
 * it would mean two competing evidence pipelines and a second host process to
 * install.
 *
 * So the vendored copy keeps the panel and the capture engine, and has the
 * native-messaging export removed at bundle time: the JSON download becomes the
 * primary export. The transform is deterministic and asserted, so a change in
 * upstream Fe-shot that would silently break it fails the build instead.
 *
 * `--check` verifies the vendored copy is current without writing.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEST = join(ROOT, 'extensions', 'context-capsule');

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const sourceArg = args[args.indexOf('--source') + 1];
const SOURCE = resolve(
  sourceArg && !sourceArg.startsWith('--')
    ? sourceArg
    : process.env.FESHOT_SOURCE ?? join(ROOT, '..', 'Fe-shot'),
);

const SRC_EXT = join(SOURCE, 'extension');

/** Files copied verbatim. Anything else in the source tree is deliberately left behind. */
const COPY = [
  'manifest.json',
  'background.js',
  'content.js',
  'redact.js',
  'session-store.js',
  'sidepanel.html',
  'sidepanel.css',
  'sidepanel.js',
  'tokens.css',
  'icons',
];

function fail(message) {
  console.error(`\nvendor-extension: ${message}\n`);
  process.exit(1);
}

/**
 * Read a text file with line endings normalised to LF.
 *
 * Fe-shot is checked out with CRLF on Windows, so anchors written with LF would
 * never match and every run would fail the guard below.
 */
function readText(path) {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

/** Apply one required edit, and fail loudly if the anchor is gone. */
function edit(source, label, find, replace) {
  if (!source.includes(find)) {
    fail(
      `could not apply "${label}" - the upstream code no longer matches.\n` +
        `  Expected to find:\n    ${find.split('\n')[0].trim()}\n` +
        `  Re-check Fe-shot's extension/sidepanel.js and update scripts/vendor-extension.mjs.`,
    );
  }
  return source.replace(find, replace);
}

/**
 * Strip the native-messaging export.
 *
 * The panel keeps working because the JSON download is an independent path that
 * never touched the native host.
 */
function transformSidepanel(source) {
  let out = source;

  // 1. The export button now downloads instead of talking to a native host.
  out = edit(
    out,
    'export button -> download',
    `        const result =
          await writeCapsuleToNative(
            capsule
          ).catch((error) => {
            throw describeNativeError(error);
          });`,
    `        /*
         * browserd build: the native messaging host is not installed, because
         * browserd itself is the agent interface. Write the capsule to disk
         * through the downloads API instead.
         */
        const result =
          await writeCapsuleToDownload(
            capsule
          );`,
  );

  // 2. Report where it landed, without inventing a native directory.
  out = edit(
    out,
    'export result copy',
    `        lastExportPath =
          result.directory || result.captureId;

        showExportResult(
          \`Prompt copied. Paste to your agent. \` +
            \`Files: \${lastExportPath}\`,
          lastExportPath
        );`,
    `        lastExportPath = result.filename;

        showExportResult(
          \`Prompt copied. Paste to your agent. \` +
            \`File: \${result.filename}\`,
          lastExportPath
        );`,
  );

  // 3. Replace the transport itself.
  const nativeStart = out.indexOf('async function writeCapsuleToNative(');
  if (nativeStart === -1) fail('writeCapsuleToNative() not found in sidepanel.js');
  const nativeEnd = out.indexOf('\nfunction ', nativeStart + 1);
  const afterNative = nativeEnd === -1 ? out.length : nativeEnd;

  const replacement = `async function writeCapsuleToDownload(
  capsule
) {
  /*
   * browserd build: capsules are written through chrome.downloads rather than
   * a native messaging host, so no companion process has to be installed.
   * The full capsule is used here, not the trimmed JSON fallback, because the
   * agent reading it wants the same evidence the native path would have sent.
   */
  const filename =
    \`context-capsule/\${capsule.captureId}.json\`;

  const blob = new Blob(
    [
      JSON.stringify(
        capsule.fallback ?? capsule,
        null,
        2
      )
    ],
    { type: "application/json" }
  );

  const url =
    URL.createObjectURL(blob);

  try {
    await chrome.downloads.download({
      url,
      filename,
      saveAs: false
    });
  } finally {
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 10_000);
  }

  return {
    captureId: capsule.captureId,
    filename,
    directory: ""
  };
}
`;

  out = out.slice(0, nativeStart) + replacement + out.slice(afterNative);

  // 4. Drop the now-unreachable host name constant.
  out = edit(
    out,
    'host name constant',
    `const HOST_NAME =
  "com.contextcapsule.host";`,
    `/* browserd build: no native messaging host; see writeCapsuleToDownload. */`,
  );

  // 5. Drop the companion-host error helper. It is unreachable now, and its
  //    message tells the user to install a host browserd does not use.
  out = edit(
    out,
    'native error helper',
    `function describeNativeError(error) {
  const text = String(error?.message || error);

  if (/not found|forbidden|not allowed/i.test(text)) {
    return new Error(
      "The companion host is not registered, so nothing can be " +
        "written to disk. Run:  node companion/install-host.mjs " +
        chrome.runtime.id +
        "  then restart Chrome. Meanwhile, Download JSON fallback " +
        "below works without it."
    );
  }

  return error instanceof Error ? error : new Error(text);
}`,
    `/* browserd build: companion-host error helper removed with the native path. */`,
  );

  for (const banned of ['connectNative', 'describeNativeError', 'com.contextcapsule']) {
    if (out.includes(banned)) {
      fail(`"${banned}" still present after transform - the strip is incomplete`);
    }
  }
  return out;
}

/** Remove the permission the stripped code no longer uses. */
function transformManifest(source) {
  const manifest = JSON.parse(source);
  const before = manifest.permissions.length;
  manifest.permissions = manifest.permissions.filter((p) => p !== 'nativeMessaging');
  if (manifest.permissions.length === before) {
    fail('manifest had no nativeMessaging permission - upstream changed');
  }
  manifest.description =
    'Point at the bug, ship the evidence. Bundled with browserd: capture visual, DOM, console and network context from any page.';
  // The signing key pins the extension id; browserd loads unpacked, so it is
  // noise here and would tie the bundled copy to upstream's identity.
  delete manifest.key;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Point the panel's export copy at the download path. */
function transformHtml(source) {
  return edit(
    source,
    'export button label',
    `          Create local capsule
        </button>`,
    `          Save capsule to Downloads
        </button>`,
  );
}

function hashTree(dir) {
  const hash = createHash('sha256');
  const walk = (d, prefix = '') => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const p = join(d, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(p, rel);
      else {
        hash.update(rel);
        hash.update(readFileSync(p));
      }
    }
  };
  walk(dir);
  return hash.digest('hex');
}

function build() {
  if (!existsSync(SRC_EXT)) {
    fail(
      `Fe-shot extension not found at ${SRC_EXT}\n` +
        `  Pass --source <path-to-Fe-shot> or set FESHOT_SOURCE.`,
    );
  }

  const staging = `${DEST}.tmp`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  for (const item of COPY) {
    const from = join(SRC_EXT, item);
    if (!existsSync(from)) fail(`missing ${item} in ${SRC_EXT}`);
    cpSync(from, join(staging, item), { recursive: true });
  }

  writeFileSync(
    join(staging, 'sidepanel.js'),
    transformSidepanel(readText(join(staging, 'sidepanel.js'))),
    'utf8',
  );
  writeFileSync(
    join(staging, 'manifest.json'),
    transformManifest(readText(join(staging, 'manifest.json'))),
    'utf8',
  );
  writeFileSync(
    join(staging, 'sidepanel.html'),
    transformHtml(readText(join(staging, 'sidepanel.html'))),
    'utf8',
  );

  const upstreamVersion = JSON.parse(readText(join(SOURCE, 'package.json'))).version;
  writeFileSync(
    join(staging, 'VENDORED.md'),
    `# Vendored: Context Capsule

Generated by \`scripts/vendor-extension.mjs\` - **do not edit these files by hand.**

| | |
| --- | --- |
| Upstream | Fe-shot (\`context-capsule\`) v${upstreamVersion} |
| Vendored | ${new Date().toISOString().slice(0, 10)} |

## What changed from upstream

- **Native messaging export removed.** browserd is already the agent interface;
  running the extension's own MCP host alongside it would mean two competing
  evidence pipelines and a second process to install. Capsules are written
  through \`chrome.downloads\` instead.
- \`nativeMessaging\` permission dropped, since nothing uses it any more.
- Signing \`key\` dropped: browserd loads the extension unpacked, so pinning
  upstream's extension id would be misleading.

Everything else - the capture engine, redaction, the side panel - is upstream's.

To refresh after Fe-shot changes:

\`\`\`bash
npm run vendor:extension
\`\`\`
`,
    'utf8',
  );

  if (CHECK) {
    if (!existsSync(DEST)) {
      rmSync(staging, { recursive: true, force: true });
      fail('no vendored copy present. Run: npm run vendor:extension');
    }
    // VENDORED.md carries a date, so compare only the code.
    const fresh = hashTree(staging);
    rmSync(join(staging, 'VENDORED.md'), { force: true });
    const freshCode = hashTree(staging);
    const currentCopy = join(`${DEST}.check`, '');
    rmSync(currentCopy, { recursive: true, force: true });
    cpSync(DEST, currentCopy, { recursive: true });
    rmSync(join(currentCopy, 'VENDORED.md'), { force: true });
    const currentCode = hashTree(currentCopy);
    rmSync(staging, { recursive: true, force: true });
    rmSync(currentCopy, { recursive: true, force: true });
    void fresh;

    if (freshCode !== currentCode) {
      fail('vendored copy is stale. Run: npm run vendor:extension');
    }
    console.log('\nvendored extension is up to date.\n');
    return;
  }

  rmSync(DEST, { recursive: true, force: true });
  mkdirSync(dirname(DEST), { recursive: true });
  cpSync(staging, DEST, { recursive: true });
  rmSync(staging, { recursive: true, force: true });

  let files = 0;
  let bytes = 0;
  const count = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) count(p);
      else {
        files++;
        bytes += statSync(p).size;
      }
    }
  };
  count(DEST);

  console.log(`\nVendored Context Capsule v${upstreamVersion}`);
  console.log(`  from  ${SRC_EXT}`);
  console.log(`  to    ${relative(ROOT, DEST)}`);
  console.log(`  ${files} files, ${(bytes / 1024).toFixed(0)} KB`);
  console.log(`  native messaging export stripped; downloads used instead\n`);
}

build();
