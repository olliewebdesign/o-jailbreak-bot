'use strict';

// Keeps O Jailbreak running. The bot runs as a separate process so that:
// • after /update it restarts on the new version — and if the new version won't start, the old one is put back
// • if it crashes, or can't reach Discord (an outage), it's started again.

const { spawn } = require('node:child_process');
const updater = require('./updater');
const { version } = require('../package.json');

const FATAL = 2; // a problem someone has to fix first (wrong token, an intent switched off): don't restart
const RESTART = 3; // the bot asked to be restarted (after /update)
const TEMPORARY = 4; // couldn't reach Discord: keep trying (not a crash, and not a broken update)
const STARTUP_LIMIT_MS = 3 * 60_000;
const CRASH_WINDOW_MS = 10 * 60_000;
const MAX_CRASHES = 5;
const MAX_RETRY_DELAY_MS = 5 * 60_000;

function launch({ root, entry, restartDelayMs = 5000, retryDelayMs = 15_000 }) {
  let child = null;
  let stopping = false;
  const crashes = [];
  let nextRetryMs = retryDelayMs;

  function start() {
    const trying = updater.pendingUpdate(root);
    if (trying) console.log(`[launcher] Starting the new version (v${trying.toVersion})...`);

    const startedAt = Date.now();
    let errorTail = '';
    child = spawn(process.execPath, [entry], { cwd: root, stdio: ['inherit', 'inherit', 'pipe'], env: { ...process.env, OJ_SUPERVISED: '1', OJ_LAUNCHER: version } });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      errorTail = `${errorTail}${chunk}`.slice(-4000);
    });

    const running = child;
    const startupLimit = trying
      ? setTimeout(() => {
          if (!updater.pendingUpdate(root)) return;
          errorTail += '\nThe new version did not come online within 3 minutes.';
          running.kill();
        }, STARTUP_LIMIT_MS)
      : null;

    child.on('exit', (code, signal) => {
      clearTimeout(startupLimit);
      child = null;
      if (stopping) process.exit(code ?? 0);

      // It ran fine for a while before this, so start the retry wait from the beginning again.
      if (Date.now() - startedAt > CRASH_WINDOW_MS) nextRetryMs = retryDelayMs;
      if (code === TEMPORARY) {
        console.error(`[launcher] Trying to connect again in ${Math.round(nextRetryMs / 1000)} seconds...`);
        setTimeout(start, nextRetryMs);
        nextRetryMs = Math.min(nextRetryMs * 2, MAX_RETRY_DELAY_MS);
        return;
      }

      // Only the update this process was started for can fail. Not the one it has just installed itself and is
      // exiting to hand over (a new update), and not one it already reported as working.
      const waiting = updater.pendingUpdate(root);
      if (trying && waiting && waiting.at === trying.at) {
        console.error('\n[launcher] The new version didn’t start properly, so the previous version is being put back.\n');
        updater.rollBack(errorTail || `It stopped (exit code ${code ?? signal}).`, root);
        start();
        return;
      }
      if (code === RESTART) {
        start();
        return;
      }
      if (code === 0 || code === FATAL) process.exit(code);

      const now = Date.now();
      crashes.push(now);
      while (now - crashes[0] > CRASH_WINDOW_MS) crashes.shift();
      if (crashes.length >= MAX_CRASHES) {
        console.error(`[launcher] O Jailbreak crashed ${MAX_CRASHES} times in 10 minutes, so it won't be restarted. Read the errors above.`);
        process.exit(1);
      }
      console.error(`[launcher] O Jailbreak stopped unexpectedly. Starting it again in ${Math.round(restartDelayMs / 1000)} seconds...`);
      setTimeout(start, restartDelayMs);
    });
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      stopping = true;
      if (!child) process.exit(0);
      // On Windows the bot receives Ctrl+C / closing the window itself; elsewhere pass the signal on so it can save.
      if (process.platform !== 'win32') child.kill(signal);
      setTimeout(() => process.exit(0), 10_000).unref();
    });
  }

  start();
}

module.exports = { launch, FATAL, RESTART, TEMPORARY };
