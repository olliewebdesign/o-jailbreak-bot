'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// /update: reading update zips, installing them with a backup, and the launcher's restart and roll-back.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const updater = require('../src/updater');

const { UpdateError, crc32, readZip, planUpdate, installUpdate, pendingUpdate, confirmUpdate, rollBack, takeFailure } = updater;

// A small zip writer, so the tests don't need any zip tool.
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content, { store = false, badCrc = false } = {}] of files) {
    const data = Buffer.from(content);
    const packed = store || name.endsWith('/') ? data : zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const crc = badCrc ? (crc32(data) ^ 1) >>> 0 : crc32(data);
    const method = store || name.endsWith('/') ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

const pkg = (version, deps = { 'discord.js': '^14.27.0' }) => JSON.stringify({ name: 'o-jailbreak', version, dependencies: deps });

function tempProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oj-update-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const planOf = (files) => ({ version: JSON.parse(files['package.json']).version, files: Object.entries(files).map(([rel, c]) => ({ rel, data: Buffer.from(c) })) });

test('update zips are read exactly; damaged and non-zip files are refused', () => {
  const zip = makeZip([
    ['src/', ''],
    ['package.json', pkg('2.0.0')],
    ['src/index.js', 'console.log("hi")', { store: true }],
  ]);
  const entries = readZip(zip);
  assert.deepEqual(entries.map((e) => e.name), ['package.json', 'src/index.js']);
  assert.equal(entries[1].data.toString(), 'console.log("hi")');

  assert.throws(() => readZip(makeZip([['package.json', pkg('2.0.0'), { badCrc: true }]])), (err) => err instanceof UpdateError && /damaged/.test(err.message));
  assert.throws(() => readZip(Buffer.from('definitely not a zip file, just some text')), /isn’t a zip file/);
});

test('an update only installs O Jailbreak files: never the token, saved data or packages; unsafe or fake zips are refused', () => {
  const plan = planUpdate(
    readZip(
      makeZip([
        ['o-jailbreak/package.json', pkg('2.0.0')],
        ['o-jailbreak/src/index.js', '1'],
        ['o-jailbreak/src/filters/new.js', '2'],
        ['o-jailbreak/README.md', '3'],
        ['o-jailbreak/.env', 'DISCORD_TOKEN=someone-elses'],
        ['o-jailbreak/data/database.json', '{}'],
        ['o-jailbreak/node_modules/x/index.js', '4'],
        ['o-jailbreak/weird/script.sh', '5'],
      ]),
    ),
  );
  assert.equal(plan.version, '2.0.0');
  assert.deepEqual(plan.files.map((f) => f.rel), ['package.json', 'src/index.js', 'src/filters/new.js', 'README.md'], 'the zipped folder is unwrapped');
  assert.deepEqual(plan.kept, ['.env', 'data/database.json', 'node_modules/x/index.js']);
  assert.deepEqual(plan.ignored, ['weird/script.sh']);

  const unsafe = makeZip([['package.json', pkg('2.0.0')], ['src/index.js', '1'], ['src/../../evil.js', '2']]);
  assert.throws(() => planUpdate(readZip(unsafe)), /unsafe file path/);
  const notOurs = makeZip([['package.json', JSON.stringify({ name: 'some-other-bot' })], ['src/index.js', '1']]);
  assert.throws(() => planUpdate(readZip(notOurs)), /isn’t an O Jailbreak update/);
});

test('installing backs up what it replaces and keeps the token and data; broken code is refused; the same update twice is "up to date"', () => {
  const root = tempProject({
    'package.json': pkg('1.0.0'),
    'src/index.js': 'module.exports = "old";',
    'config.js': 'module.exports = { timeoutDays: 3 };',
    '.env': 'DISCORD_TOKEN=keep-me',
    'data/database.json': '{"guilds":{}}',
  });
  const npmCalls = [];
  const installPackages = () => npmCalls.push('npm') && { ok: true };

  const broken = planOf({ 'package.json': pkg('1.1.0'), 'src/index.js': 'function (' });
  assert.throws(() => installUpdate(broken, { by: 'me', root, installPackages }), /broken file \(`src\/index\.js`\)/);
  assert.equal(read(root, 'src/index.js'), 'module.exports = "old";', 'nothing changed');
  assert.equal(pendingUpdate(root), null);

  const good = planOf({
    'package.json': pkg('1.1.0'),
    'src/index.js': 'module.exports = "new";',
    'src/added.js': 'module.exports = 1;',
    'config.js': 'module.exports = { timeoutDays: 7 };',
  });
  const result = installUpdate(good, { by: 'owner-id', root, installPackages });
  assert.equal(result.upToDate, false);
  assert.deepEqual(new Set(result.replaced), new Set(['package.json', 'src/index.js', 'config.js']));
  assert.deepEqual(result.added, ['src/added.js']);
  assert.equal(result.fromVersion, '1.0.0');
  assert.equal(result.toVersion, '1.1.0');
  assert.equal(result.configReplaced, true);
  assert.deepEqual(npmCalls, [], 'same packages, so no npm install');

  assert.equal(read(root, 'src/index.js'), 'module.exports = "new";');
  assert.equal(read(root, 'config.backup.js'), 'module.exports = { timeoutDays: 3 };');
  assert.equal(read(root, '.env'), 'DISCORD_TOKEN=keep-me');
  assert.equal(read(root, 'data/database.json'), '{"guilds":{}}');
  assert.equal(pendingUpdate(root).by, 'owner-id');

  assert.deepEqual(installUpdate(good, { by: 'owner-id', root, installPackages }), { upToDate: true, version: '1.1.0' });
});

test('rolling back restores the old files and reports the failure once; confirming clears the pending update', () => {
  const root = tempProject({ 'package.json': pkg('1.0.0'), 'src/index.js': 'module.exports = "old";' });
  const plan = planOf({ 'package.json': pkg('1.1.0'), 'src/index.js': 'module.exports = "new";', 'src/added.js': '1;' });

  installUpdate(plan, { by: 'owner-id', root });
  assert.equal(rollBack('Error: the new version is broken', root), true);
  assert.equal(read(root, 'src/index.js'), 'module.exports = "old";');
  assert.equal(JSON.parse(read(root, 'package.json')).version, '1.0.0');
  assert.equal(fs.existsSync(path.join(root, 'src/added.js')), false, 'added files removed');
  assert.equal(pendingUpdate(root), null);
  const failure = takeFailure(root);
  assert.equal(failure.toVersion, '1.1.0');
  assert.match(failure.error, /the new version is broken/);
  assert.equal(takeFailure(root), null, 'only reported once');

  installUpdate(plan, { by: 'owner-id', root });
  assert.equal(confirmUpdate(root).toVersion, '1.1.0');
  assert.equal(pendingUpdate(root), null);
  assert.equal(read(root, 'src/index.js'), 'module.exports = "new";');
});

test('new packages are installed; if that fails, the old version is put back', () => {
  const root = tempProject({ 'package.json': pkg('1.0.0'), 'src/index.js': 'module.exports = "old";' });
  const calls = [];
  const failingNpm = () => {
    calls.push('npm');
    return { ok: calls.length > 1, output: 'npm ERR! network down' };
  };
  const plan = planOf({ 'package.json': pkg('1.1.0', { 'discord.js': '^15.0.0' }), 'src/index.js': 'module.exports = "new";' });
  assert.throws(() => installUpdate(plan, { by: 'me', root, installPackages: failingNpm }), /Installing the new packages failed[\s\S]*network down/);
  assert.equal(read(root, 'src/index.js'), 'module.exports = "old";');
  assert.equal(calls.length, 2, 'installed again for the old version');
  assert.equal(pendingUpdate(root), null);
});

test('the bot can tell when the watcher is still running older code (a host restart finishes the update)', () => {
  assert.equal(updater.launcherOutOfDate('1.4.1', { OJ_SUPERVISED: '1', OJ_LAUNCHER: '1.3.2' }), true, 'updated, watcher is behind');
  assert.equal(updater.launcherOutOfDate('1.4.1', { OJ_SUPERVISED: '1', OJ_LAUNCHER: '1.4.1' }), false, 'restarted, all matching');
  assert.equal(updater.launcherOutOfDate('1.4.1', { OJ_SUPERVISED: '1' }), true, 'an old watcher does not say which version it is');
  assert.equal(updater.launcherOutOfDate('1.4.1', {}), false, 'not running under a watcher at all');
});

// ----- the launcher, run for real with pretend bots -----

const LAUNCHER = path.join(__dirname, '..', 'src', 'launcher.js');

function runLauncher(root) {
  const driver = path.join(root, 'driver.js');
  fs.writeFileSync(
    driver,
    `require(${JSON.stringify(LAUNCHER)}).launch({ root: ${JSON.stringify(root)}, entry: ${JSON.stringify(path.join(root, 'src', 'index.js'))}, restartDelayMs: 20, retryDelayMs: 20 });`,
  );
  const result = spawnSync(process.execPath, [driver], { encoding: 'utf8', timeout: 30_000 });
  const runs = fs.existsSync(path.join(root, 'runs.txt')) ? read(root, 'runs.txt').trim().split('\n') : [];
  return { code: result.status, runs, output: `${result.stdout}${result.stderr}` };
}

// A pretend bot that records each run and exits with the next code in the list.
const fakeBot = (label, codes) => `
const fs = require('fs'), path = require('path');
const log = path.join(__dirname, '..', 'runs.txt');
const run = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean).length : 0;
fs.appendFileSync(log, ${JSON.stringify(label)} + '\\n');
const codes = ${JSON.stringify(codes)};
if (codes[run] === 1) console.error('Error: ${label} crashed');
process.exit(codes[run] ?? 0);
`;

test('launcher: restarts after /update and after a crash, and stops for good on a fatal problem', () => {
  const restart = runLauncher(tempProject({ 'package.json': pkg('1.0.0'), 'src/index.js': fakeBot('bot', [3, 0]) }));
  assert.equal(restart.code, 0);
  assert.deepEqual(restart.runs, ['bot', 'bot']);

  const crash = runLauncher(tempProject({ 'package.json': pkg('1.0.0'), 'src/index.js': fakeBot('bot', [1, 0]) }));
  assert.equal(crash.code, 0);
  assert.deepEqual(crash.runs, ['bot', 'bot']);
  assert.match(crash.output, /stopped unexpectedly/);

  const fatal = runLauncher(tempProject({ 'package.json': pkg('1.0.0'), 'src/index.js': fakeBot('bot', [2]) }));
  assert.equal(fatal.code, 2);
  assert.deepEqual(fatal.runs, ['bot']);

  const outage = runLauncher(tempProject({ 'package.json': pkg('1.0.0'), 'src/index.js': fakeBot('bot', [4, 4, 4, 4, 4, 4, 0]) }));
  assert.equal(outage.code, 0);
  assert.equal(outage.runs.length, 7, "keeps trying while Discord is down (it isn't counted as crashing)");
  assert.match(outage.output, /Trying to connect again/);
});

// The real /update sequence: the running (old) version installs the update, then exits so the launcher starts the new one.
const UPDATER = path.join(__dirname, '..', 'src', 'updater.js');
const oldVersionThatUpdates = `
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const updater = require(${JSON.stringify(UPDATER)});
fs.appendFileSync(path.join(root, 'runs.txt'), 'old\\n');
console.error('[restrict] a harmless warning printed by the old version');
const request = path.join(root, 'update-request.json');
if (fs.existsSync(request)) {
  const plan = JSON.parse(fs.readFileSync(request, 'utf8'));
  fs.rmSync(request);
  updater.installUpdate({ version: plan.version, files: plan.files.map((f) => ({ rel: f.rel, data: Buffer.from(f.data) })) }, { by: 'owner-id', root });
  process.exit(3);
}
process.exit(0);
`;
const newVersion = (works) => `
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
fs.appendFileSync(path.join(root, 'runs.txt'), 'new\\n');
if (${works}) {
  require(${JSON.stringify(UPDATER)}).confirmUpdate(root);
  process.exit(0);
}
console.error('Error: the new version is broken');
process.exit(1);
`;
// A pretend bot that says "I started fine" and then installs the next update if one is waiting for it.
const chainBot = (label) => `
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const updater = require(${JSON.stringify(UPDATER)});
fs.appendFileSync(path.join(root, 'runs.txt'), ${JSON.stringify(label)} + '\\n');
updater.confirmUpdate(root);
const request = path.join(root, 'update-request.json');
if (fs.existsSync(request)) {
  const plan = JSON.parse(fs.readFileSync(request, 'utf8'));
  fs.rmSync(request);
  updater.installUpdate({ version: plan.version, files: plan.files.map((f) => ({ rel: f.rel, data: Buffer.from(f.data) })) }, { by: 'owner-id', root });
  process.exit(3);
}
process.exit(0);
`;

test('launcher + /update: a version that arrived by /update can install the next one without being rolled back', () => {
  const root = tempProject({ 'package.json': pkg('1.0.0'), 'src/index.js': chainBot('v1') });
  // v1.1.0 has been installed and is about to be started for the first time...
  installUpdate(planOf({ 'package.json': pkg('1.1.0'), 'src/index.js': chainBot('v2') }), { by: 'owner-id', root });
  // ...and while it's running, someone sends it v1.2.0 with /update.
  fs.writeFileSync(
    path.join(root, 'update-request.json'),
    JSON.stringify({ version: '1.2.0', files: [{ rel: 'package.json', data: pkg('1.2.0') }, { rel: 'src/index.js', data: chainBot('v3') }] }),
  );

  const result = runLauncher(root);
  assert.equal(result.code, 0);
  assert.deepEqual(result.runs, ['v2', 'v3'], 'the second update was started, not undone');
  assert.equal(JSON.parse(read(root, 'package.json')).version, '1.2.0');
  assert.equal(pendingUpdate(root), null);
  assert.equal(takeFailure(root), null, 'nothing was reported as failed');
  assert.doesNotMatch(result.output, /previous version is being put back/);
});

function projectWithUpdateRequest(works) {
  const root = tempProject({ 'package.json': pkg('1.0.0'), 'src/index.js': oldVersionThatUpdates });
  const files = [
    { rel: 'package.json', data: pkg('1.1.0') },
    { rel: 'src/index.js', data: newVersion(works) },
  ];
  fs.writeFileSync(path.join(root, 'update-request.json'), JSON.stringify({ version: '1.1.0', files }));
  return root;
}

test('launcher + /update: the old version installs the update and exits, and the new version starts and stays', () => {
  const root = projectWithUpdateRequest(true);
  const result = runLauncher(root);
  assert.equal(result.code, 0);
  assert.deepEqual(result.runs, ['old', 'new'], 'the update was not undone when the old version exited');
  assert.equal(read(root, 'src/index.js'), newVersion(true), 'the new files are still in place');
  assert.equal(JSON.parse(read(root, 'package.json')).version, '1.1.0');
  assert.equal(pendingUpdate(root), null);
  assert.equal(takeFailure(root), null);
});

test("launcher + /update: if the new version crashes, the old one comes back and the owner is told the new version's error", () => {
  const root = projectWithUpdateRequest(false);
  const result = runLauncher(root);
  assert.equal(result.code, 0);
  assert.deepEqual(result.runs, ['old', 'new', 'old']);
  assert.equal(JSON.parse(read(root, 'package.json')).version, '1.0.0');
  const failure = takeFailure(root);
  assert.match(failure.error, /the new version is broken/);
  assert.doesNotMatch(failure.error, /harmless warning printed by the old version/, "the old version's log isn't blamed");
});

test("launcher: if Discord is down while a new version starts, it keeps trying instead of rolling the update back", () => {
  const root = tempProject({ 'package.json': pkg('1.0.0'), 'src/index.js': fakeBot('old', [0]) });
  const newVersion = `${fakeBot('new', [4, 4, 0]).replace(
    "process.exit(codes[run] ?? 0);",
    `if ((codes[run] ?? 0) === 0) require(${JSON.stringify(path.join(__dirname, '..', 'src', 'updater.js'))}).confirmUpdate(path.join(__dirname, '..'));
process.exit(codes[run] ?? 0);`,
  )}`;
  installUpdate(planOf({ 'package.json': pkg('1.1.0'), 'src/index.js': newVersion }), { by: 'owner-id', root });

  const result = runLauncher(root);
  assert.equal(result.code, 0);
  assert.deepEqual(result.runs, ['new', 'new', 'new'], 'never went back to the old version');
  assert.match(read(root, 'src/index.js'), /"new"/);
  assert.equal(pendingUpdate(root), null, 'confirmed once it connected');
  assert.equal(takeFailure(root), null);
});

test("launcher: an update that won't start is rolled back to the old version, and the error is kept for the owner", () => {
  const root = tempProject({ 'package.json': pkg('1.0.0'), 'src/index.js': fakeBot('old', [0, 0]) });
  installUpdate(planOf({ 'package.json': pkg('1.1.0'), 'src/index.js': fakeBot('new', [1]) }), { by: 'owner-id', root });

  const result = runLauncher(root);
  assert.equal(result.code, 0);
  assert.deepEqual(result.runs, ['new', 'old'], 'tried the new version, then went back to the old one');
  assert.match(result.output, /previous version is being put back/);
  assert.match(read(root, 'src/index.js'), /"old"/);
  assert.equal(JSON.parse(read(root, 'package.json')).version, '1.0.0');
  assert.equal(pendingUpdate(root), null);
  assert.match(takeFailure(root).error, /new crashed/);
});
