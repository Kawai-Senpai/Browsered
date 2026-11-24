import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PNG } from 'pngjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const home = await mkdtemp(join(tmpdir(), 'browserd-visual-test-'));
const client = new Client({ name: 'visual-review-test', version: '1' });
const server = createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end(`
<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{margin:0;padding:16px;font:16px system-ui;min-height:1000px} #toolbar{display:flex;gap:8px}
button{width:54px;height:32px} #second{margin-left:16px;transform:translateY(7px)}
#primary{color:#ddd;background:#eee;border:0} #clock{width:80px;height:24px}
#cover{position:absolute;z-index:5;top:0;left:0;width:10px;height:10px;background:#111}
#outside{width:340px;height:12px;background:#eff}
</style>
<div id="toolbar"><button id="primary">Save</button><button id="second">Edit</button><button>Copy</button><button>Done</button></div>
<div id="clock">09:00</div><div id="outside"></div><div id="cover"></div>
`));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const transport = new StdioClientTransport({
  command: process.execPath, args: [join(root, 'dist', 'cli.js'), '--log-level', 'warn'],
  env: { ...process.env, AGENTBROWSER_HOME: home, AGENTBROWSER_HEADLESS: '1', AGENTBROWSER_TOOL_FAMILIES: 'browser,page,device,js,visual,attention' },
  stderr: 'inherit',
});
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  const value = JSON.parse(response.content.find(item => item.type === 'text').text);
  if (response.isError) throw Object.assign(new Error(name + ' ' + value.message), { code: value.code });
  return value;
}
let browserId;
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert(tools.every(tool => /^(browser|page|device|js|visual|attention|guide)\./.test(tool.name)));
  assert.equal((await call('guide.list')).tool_count, tools.length);
  assert.equal((await call('guide.search', { query: 'visual QA regression review' })).suggested_calls[0].tool, 'visual.review');
  assert.equal((await call('guide.search', { query: 'I cannot click this checkbox' })).suggested_calls[0].tool, 'visual.inspect_target');
  const browser = await call('browser.launch', { headless: true, profile: 'visual-check' });
  const browser_id = browserId = browser.browser_id;
  const scope = { browser_id };
  await call('page.navigate', { ...scope, url: 'http://127.0.0.1:' + server.address().port });
  await call('device.viewport', { ...scope, width: 700, height: 520, device_scale_factor: 2 });
  const single = await call('page.screenshot', { ...scope, attention_targets: [{ name:'save', selector:'#primary' }], return_image:false });
  assert.equal(single.screenshot_regions.width, 1400);
  assert.equal(single.screenshot_regions.goals[0].box.x, 32);
  assert.equal(single.screenshot_regions.goals[0].box.width, 108);
  const extras = { ...scope, widths: [320, 640], height: 400, baseline: 'fixture/default',
    mask_selectors: ['#clock'], attention_targets: [{ name: 'save', text: 'Save' }], attention: !process.argv.includes('--no-attention') };
  const first = await call('visual.review', extras);
  const [phone, desktop] = first.viewports;
  assert.equal(phone.comparison.status, 'no_approved_baseline');
  assert(phone.stable && desktop.stable, JSON.stringify(first.viewports.map(v=>[v.stable,v.pixel_width,v.pixel_height,v.capture_diagnostic])));
  assert(phone.horizontal_scroll && !desktop.horizontal_scroll);
  assert(desktop.counts.misaligned_peers && desktop.counts.inconsistent_peer_spacing && desktop.counts.low_text_contrast);
  assert(desktop.findings.some(issue => issue.selector === '#second' && issue.box && issue.detail.deviation_px === 7));
  assert.deepEqual((await call('js.evaluate', { ...scope, expression: '[innerWidth,innerHeight,devicePixelRatio]' })).value, [700, 520, 2]);
  const viewHtml = await readFile(first.report_view.path, 'utf8');
  assert(viewHtml.includes('<svg') && viewHtml.includes('Audit findings'));
  if (extras.attention) {
    assert(desktop.attention.overlay, JSON.stringify(desktop.attention));
    assert(desktop.attention.attention_targets[0].share >= 0);
    assert(viewHtml.includes('Predicted attention'));
  }
  await call('visual.approve_baseline', { name: 'fixture/default', report_id: first.report_data.artifact_id });
  await call('js.evaluate', { ...scope, expression: "document.querySelector('#clock').textContent = '10:30'; 0" });
  const identical = await call('visual.review', { ...extras, attention: false, mask_selectors: undefined });
  assert(identical.viewports.every(v => v.comparison.changed_pixels === 0), JSON.stringify(identical.viewports.map(v=>({comparison:v.comparison, diagnostic:v.capture_diagnostic}))));
  await call('js.evaluate', { ...scope, expression: `
    document.querySelector('#second').style.cssText='margin:0;transform:none';
    document.querySelector('#primary').style.cssText='color:#fff;background:#16318d;transform:translateY(40px)';
    document.querySelector('#cover').style.cssText='position:absolute;z-index:5;top:55px;left:15px;width:56px;height:40px';
    0
  ` });
  const second = await call('visual.review', { ...scope, baseline: 'fixture/default' });
  assert(second.viewports.every(view => view.stable), JSON.stringify(second.viewports.map(v => v.capture_diagnostic)));
  const compared = second.viewports[1].comparison;
  assert.equal(compared.status, 'compared');
  assert(compared.changed_pixels > 0 && compared.largest_changed_regions.length && compared.diff);
  assert(compared.findings.resolved_samples.some(f => f.code === 'low_text_contrast' && f.selector === '#primary'));
  const diff = PNG.sync.read(await readFile(compared.diff.path));
  assert.equal(diff.width, 640);
  if (extras.attention) {
    assert.equal(compared.attention_targets[0].name, 'save');
    assert.notEqual(second.viewports[1].attention.attention_targets[0].box.y, desktop.attention.attention_targets[0].box.y);
    const approach = await call('attention.compare', {
      baseline_id: desktop.screenshot.artifact_id, candidate_id: second.viewports[1].screenshot.artifact_id, balance: true,
    });
    assert.notEqual(approach.attention_targets[0].candidate.box.y, approach.attention_targets[0].baseline.box.y);
    assert(approach.visual_balance.baseline.shares);
  }
  const hit = await call('visual.inspect_target', { ...scope, selector: '#primary' });
  assert(hit.hit_test_front_to_back[0].selector?.includes('cover') || hit.hit_test_front_to_back[0].id === 'cover',
    JSON.stringify(hit.hit_test_front_to_back));
  await assert.rejects(call('visual.approve_baseline', { name: 'fixture/default', report_id: second.report_data.artifact_id }),
    { code: 'visual_baseline_conflict' });
  await call('visual.approve_baseline', { name: 'fixture/default', report_id: second.report_data.artifact_id,
    replace_report_id: first.report_data.artifact_id });
  assert.equal((await call('visual.list_baselines')).baselines[0].report_handle, second.report_data.artifact_id);
  console.log('Visual review MCP checks passed.');
} finally {
  if (browserId) await call('browser.close', { browser_id: browserId }).catch(() => undefined);
  await client.close();
  await new Promise(resolve => server.close(resolve));
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
