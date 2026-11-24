import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanCheckout, preparedUpdate, prepareUpdate } from '../scripts/mcp-update.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'browserd-update-test-'));
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
try {
  const remote = join(temporary, 'upstream');
  const source = join(temporary, 'source');
  const cache = join(temporary, 'cache');
  git(temporary, ['init', '-b', 'master', remote]);
  git(remote, ['config', 'user.name', 'Fixture']);
  git(remote, ['config', 'user.email', 'fixture@example.invalid']);
  const pkg = { name: 'browserd-update-fixture', version: '1.0.0' };
  await writeFile(join(remote, 'package.json'), JSON.stringify({ ...pkg, type: 'module', scripts: { build: 'node build.mjs' } }));
  await writeFile(join(remote, 'package-lock.json'), JSON.stringify({ ...pkg, lockfileVersion: 3, packages: { '': pkg } }));
  await writeFile(join(remote, 'build.mjs'), `
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const input = readFileSync('fixture.txt','utf8');
if (input === 'bad build') process.exit(1);
mkdirSync('dist',{recursive:true});
writeFileSync('dist/cli.js','process.stdout.write(' + JSON.stringify(input) + ');');
`);
  const commit = async (version) => {
    await writeFile(join(remote, 'fixture.txt'), version);
    git(remote, ['add', '.']);
    git(remote, ['commit', '-m', version]);
    return git(remote, ['rev-parse', 'HEAD']);
  };
  const restartCheck = () => utimes(join(cache, 'last-check'), new Date(0), new Date(0));
  const base = await commit('version one');
  git(temporary, ['clone', remote, source]);
  assert.equal(cleanCheckout(source, remote), base);
  assert.equal(cleanCheckout(source), undefined);
  assert.equal(preparedUpdate(cache, base), undefined);
  assert.equal(await prepareUpdate({ cache, base, remote }), 'current');
  const second = await commit('version two');
  assert.equal(await prepareUpdate({ cache, base, remote }), 'recent_check');
  await restartCheck();
  const results = await Promise.all([prepareUpdate({ cache, base, remote }), prepareUpdate({ cache, base, remote })]);
  assert(results.includes('staged ' + second));
  assert(results.includes('recent_check') || results.includes('check_in_progress'));
  let ready = preparedUpdate(cache, base);
  assert.equal(ready.revision, second);
  assert.match(await readFile(ready.path, 'utf8'), /version two/);
  assert.equal(git(source, ['rev-parse', 'HEAD']), base);
  assert.equal(await readFile(join(source, 'fixture.txt'), 'utf8'), 'version one');

  const third = await commit('version three');
  await restartCheck();
  assert.equal(await prepareUpdate({ cache, base, remote }), 'staged ' + third);
  ready = preparedUpdate(cache, base);
  assert.equal(ready.revision, third);
  assert.match(await readFile(ready.path, 'utf8'), /version three/);

  await commit('bad build');
  await restartCheck();
  await assert.rejects(prepareUpdate({ cache, base, remote }), /npm run build/);
  assert.deepEqual(preparedUpdate(cache, base), ready);

  git(remote, ['reset', '--hard', base]);
  await commit('rewritten history');
  await restartCheck();
  await assert.rejects(prepareUpdate({ cache, base, remote }), /not a fast-forward/);
  assert.deepEqual(preparedUpdate(cache, base), ready);
  await restartCheck();
  await assert.rejects(prepareUpdate({ cache, base, remote: join(temporary, 'missing-upstream') }));
  assert.deepEqual(preparedUpdate(cache, base), ready);
  assert.equal(preparedUpdate(cache, second), undefined);
  await writeFile(join(source, 'fixture.txt'), 'local edit');
  assert.equal(cleanCheckout(source, remote), undefined);
  await writeFile(join(cache, 'ready.json'), '{"revision":"../invalid"}');
  assert.equal(preparedUpdate(cache, base), undefined);
  console.log('Updater checks passed for staging, locks, fallback, and local checkout safety.');
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
