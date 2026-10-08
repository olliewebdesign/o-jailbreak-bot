'use strict';

// Installs a new version of O Jailbreak from an update zip (sent with /update). The files it replaces are backed up,
// and the launcher puts them back if the new version won't start. Only uses Node itself, so the launcher can load it.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

// Never touched by an update: the token, saved settings and cases, installed packages, and the updater's own files.
const KEEP = [/^\.env(\.|$)/, /^data\//, /^node_modules\//, /^\.update\//, /^config\.backup\.js$/];
const INSTALLABLE = [/^(?:src|test)\/[\w./-]+$/, /^[\w.-]+\.(?:js|json|md|txt|bat|cmd)$/, /^\.gitignore$/];
const JUNK = [/^__MACOSX\//, /(?:^|\/)\.DS_Store$/, /(?:^|\/)Thumbs\.db$/];

// An error whose message can be shown to the person running /update as-is.
class UpdateError extends Error {}

// ----- reading zip files (just enough for update files, so no extra packages are needed) -----

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @returns {{ name: string, data: Buffer }[]} */
function readZip(buf) {
  try {
    let end = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new UpdateError('That file isn’t a zip file. Attach the **o-jailbreak-update.zip** file exactly as you downloaded it.');

    const count = buf.readUInt16LE(end + 10);
    let at = buf.readUInt32LE(end + 16);
    if (count > MAX_FILES) throw new UpdateError('That zip has far too many files to be an O Jailbreak update.');

    const entries = [];
    let total = 0;
    for (let n = 0; n < count; n++) {
      if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('bad central directory');
      const flags = buf.readUInt16LE(at + 8);
      const method = buf.readUInt16LE(at + 10);
      const crc = buf.readUInt32LE(at + 16);
      const packedSize = buf.readUInt32LE(at + 20);
      const size = buf.readUInt32LE(at + 24);
      const nameLength = buf.readUInt16LE(at + 28);
      const local = buf.readUInt32LE(at + 42);
      const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', at + 46, at + 46 + nameLength);
      at += 46 + nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
      if (name.endsWith('/')) continue; // a folder

      total += size;
      if (flags & 0x1) throw new UpdateError('That zip is password-protected. Use the update file exactly as you downloaded it.');
      if (total > MAX_TOTAL_BYTES) throw new UpdateError('That zip is far too big to be an O Jailbreak update.');
      if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('bad local header');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const packed = buf.subarray(start, start + packedSize);
      let data;
      if (method === 0) data = Buffer.from(packed);
      else if (method === 8) data = zlib.inflateRawSync(packed, { maxOutputLength: Math.max(size, 1) });
      else throw new UpdateError('That zip uses a kind of compression I can’t read. Use the update file exactly as you downloaded it.');
      if (data.length !== size || crc32(data) !== crc) throw new Error(`${name} is damaged`);
      entries.push({ name, data });
    }
    return entries;
  } catch (err) {
    if (err instanceof UpdateError) throw err;
    throw new UpdateError(`That zip file is damaged (${err.message}). Download the update again and retry.`);
  }
}

// ----- checking what's inside -----

/**
 * Works out what an update zip would install, refusing anything that isn't an O Jailbreak update.
 * @returns {{ version: string, files: { rel: string, data: Buffer }[], kept: string[], ignored: string[] }}
 */
function planUpdate(entries) {
  let files = entries.filter((e) => !JUNK.some((re) => re.test(e.name)));

  // Someone zipped the folder rather than what's in it: everything sits inside one folder.
  if (!files.some((f) => f.name === 'package.json')) {
    const folder = files.find((f) => /^[^/]+\/package\.json$/.test(f.name))?.name.split('/')[0];
    if (folder && files.every((f) => f.name.startsWith(`${folder}/`))) files = files.map((f) => ({ ...f, name: f.name.slice(folder.length + 1) }));
  }

  let pkg = null;
  try {
    pkg = JSON.parse(files.find((f) => f.name === 'package.json').data.toString('utf8'));
  } catch {}
  if (pkg?.name !== 'o-jailbreak' || !files.some((f) => f.name === 'src/index.js')) {
    throw new UpdateError('That zip isn’t an O Jailbreak update. Attach the **o-jailbreak-update.zip** file exactly as you downloaded it.');
  }

  const plan = { version: String(pkg.version ?? 'unknown'), files: [], kept: [], ignored: [] };
  for (const { name, data } of files) {
    const parts = name.split('/');
    if (name.includes('\\') || /^[a-z]:/i.test(name) || parts.some((p) => p === '' || p === '.' || p === '..')) {
      throw new UpdateError(`That zip has an unsafe file path in it (\`${name.slice(0, 100)}\`), so I didn’t install anything.`);
    }
    if (KEEP.some((re) => re.test(name))) plan.kept.push(name);
    else if (INSTALLABLE.some((re) => re.test(name))) plan.files.push({ rel: name, data });
    else plan.ignored.push(name);
  }
  return plan;
}

// ----- installing -----

const workDir = (root) => path.join(root, '.update');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function lastLines(text, max = 900) {
  const clean = String(text ?? '').trim();
  return clean.length > max ? `…${clean.slice(-max)}` : clean;
}

function readText(dir, rel) {
  try {
    return fs.readFileSync(path.join(dir, rel), 'utf8');
  } catch {
    return null;
  }
}

// True if the packages to install are different (a new version number on its own doesn't count).
function dependenciesDiffer(root, staging) {
  const parse = (dir, rel) => {
    try {
      return JSON.parse(readText(dir, rel));
    } catch {
      return null;
    }
  };
  const lockPackages = (lock) => {
    if (!lock?.packages) return null;
    const { '': self, ...rest } = lock.packages;
    return JSON.stringify({ self: { ...self, version: undefined }, rest });
  };
  const [oldPkg, newPkg] = [parse(root, 'package.json'), parse(staging, 'package.json')];
  const [oldLock, newLock] = [parse(root, 'package-lock.json'), parse(staging, 'package-lock.json')];
  return JSON.stringify(oldPkg?.dependencies ?? {}) !== JSON.stringify(newPkg?.dependencies ?? {}) || lockPackages(oldLock) !== lockPackages(newLock);
}

function runNpmInstall(root) {
  const result = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5 * 60_000,
    shell: process.platform === 'win32',
  });
  return { ok: result.status === 0, output: lastLines(`${result.stderr ?? ''}\n${result.error?.message ?? ''}`) };
}

// Puts back the files the last update replaced, and removes the ones it added.
function restoreBackup(root) {
  const manifest = readJson(path.join(workDir(root), 'backup.json'));
  if (!manifest) return null;
  for (const rel of manifest.replaced) copyFile(path.join(workDir(root), 'backup', rel), path.join(root, rel));
  for (const rel of manifest.added) fs.rmSync(path.join(root, rel), { force: true });
  return manifest;
}

/**
 * Installs the planned files. Afterwards the bot has to restart; until the new version reports that it started
 * (confirmUpdate), the update counts as pending and the launcher will roll it back if the bot stops.
 */
function installUpdate(plan, { by, root = ROOT, installPackages = runNpmInstall } = {}) {
  const work = workDir(root);
  const staging = path.join(work, 'staging');
  const fromVersion = readJson(path.join(root, 'package.json'))?.version ?? 'unknown';

  // 1. Unpack to a staging folder and make sure every script at least loads without a syntax error.
  fs.rmSync(staging, { recursive: true, force: true });
  for (const { rel, data } of plan.files) writeFile(path.join(staging, rel), data);
  for (const { rel } of plan.files.filter((f) => f.rel.endsWith('.js'))) {
    const check = spawnSync(process.execPath, ['--check', path.join(staging, rel)], { encoding: 'utf8' });
    if (check.status !== 0) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new UpdateError(`The update has a broken file (\`${rel}\`), so I didn’t install anything.\n${lastLines(check.stderr, 500)}`);
    }
  }

  // 2. What actually changes.
  const replaced = [];
  const added = [];
  for (const { rel, data } of plan.files) {
    const target = path.join(root, rel);
    if (!fs.existsSync(target)) added.push(rel);
    else if (!fs.readFileSync(target).equals(data)) replaced.push(rel);
  }
  if (!replaced.length && !added.length) {
    fs.rmSync(staging, { recursive: true, force: true });
    return { upToDate: true, version: plan.version };
  }

  // 3. Back up what's being replaced, then copy the new files in.
  const depsChanged = dependenciesDiffer(root, staging);
  const manifest = { by, at: Date.now(), fromVersion, toVersion: plan.version, replaced, added, depsChanged };
  fs.rmSync(path.join(work, 'backup'), { recursive: true, force: true });
  for (const rel of replaced) copyFile(path.join(root, rel), path.join(work, 'backup', rel));
  writeFile(path.join(work, 'backup.json'), JSON.stringify(manifest, null, 2));

  const configReplaced = replaced.includes('config.js');
  if (configReplaced) copyFile(path.join(root, 'config.js'), path.join(root, 'config.backup.js'));
  for (const rel of [...replaced, ...added]) copyFile(path.join(staging, rel), path.join(root, rel));
  fs.rmSync(staging, { recursive: true, force: true });

  if (depsChanged) {
    const npm = installPackages(root);
    if (!npm.ok) {
      restoreBackup(root);
      installPackages(root);
      throw new UpdateError(`Installing the new packages failed, so I put the old version back.\n${npm.output}`);
    }
  }

  writeFile(path.join(work, 'pending.json'), JSON.stringify(manifest));
  return { upToDate: false, configReplaced, ...manifest };
}

/**
 * True when the part that restarts the bot is still running older code than the bot itself — which happens
 * after an update, until the host is restarted. Updates work, but each one has to be run twice.
 */
function launcherOutOfDate(version, env = process.env) {
  return Boolean(env.OJ_SUPERVISED) && env.OJ_LAUNCHER !== version;
}

/** The update waiting to prove it starts, if any. */
function pendingUpdate(root = ROOT) {
  return readJson(path.join(workDir(root), 'pending.json'));
}

/** Called by the new version once it's running properly. Returns the update it confirmed, if there was one. */
function confirmUpdate(root = ROOT) {
  const pending = pendingUpdate(root);
  if (pending) fs.rmSync(path.join(workDir(root), 'pending.json'), { force: true });
  return pending;
}

/** Called by the launcher when a new version stopped before confirming: puts the previous version back. */
function rollBack(errorText, root = ROOT, { installPackages = runNpmInstall } = {}) {
  const pending = pendingUpdate(root);
  const manifest = restoreBackup(root);
  if (manifest?.depsChanged) installPackages(root);
  if (pending) writeFile(path.join(workDir(root), 'failed.json'), JSON.stringify({ ...pending, error: lastLines(errorText, 1500) }));
  fs.rmSync(path.join(workDir(root), 'pending.json'), { force: true });
  fs.rmSync(path.join(workDir(root), 'backup.json'), { force: true });
  return Boolean(manifest);
}

/** A rolled-back update to tell the owner about (reported once). */
function takeFailure(root = ROOT) {
  const failed = readJson(path.join(workDir(root), 'failed.json'));
  if (failed) fs.rmSync(path.join(workDir(root), 'failed.json'), { force: true });
  return failed;
}

module.exports = { UpdateError, crc32, readZip, planUpdate, installUpdate, pendingUpdate, confirmUpdate, rollBack, takeFailure, launcherOutOfDate };
