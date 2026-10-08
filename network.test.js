'use strict';

require('./exampleConfig'); // made-up IDs and names (config.js ships empty)

// When the host can't reach Discord for a moment, requests are tried again instead of failing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isTemporary, retryConnectErrors } = require('../src/util');

const connectTimeout = () => Object.assign(new Error('Connect Timeout Error (attempted address: discord.com:443, timeout: 10000ms)'), { code: 'UND_ERR_CONNECT_TIMEOUT' });

test('requests that fail to connect are tried again, then succeed', async () => {
  let calls = 0;
  const request = retryConnectErrors(
    async () => {
      calls++;
      if (calls < 3) throw connectTimeout();
      return { status: 204 };
    },
    { delayMs: 1 },
  );
  assert.deepEqual(await request('https://discord.com/api/v10/channels/1/messages/2', {}), { status: 204 });
  assert.equal(calls, 3);
});

test('other errors are not retried, and retrying stops after the last attempt', async () => {
  let calls = 0;
  const refused = retryConnectErrors(
    async () => {
      calls++;
      throw Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 });
    },
    { delayMs: 1 },
  );
  await assert.rejects(refused('u', {}), /Missing Permissions/);
  assert.equal(calls, 1, 'a real answer from Discord is not repeated');

  calls = 0;
  const neverConnects = retryConnectErrors(
    async () => {
      calls++;
      throw connectTimeout();
    },
    { attempts: 3, delayMs: 1 },
  );
  await assert.rejects(neverConnects('u', {}), /Connect Timeout/);
  assert.equal(calls, 3);
});

test('temporary errors are told apart from ones that need fixing', () => {
  assert.equal(isTemporary(connectTimeout()), true);
  assert.equal(isTemporary(Object.assign(new Error('Internal Server Error'), { status: 500 })), true);
  assert.equal(isTemporary(Object.assign(new Error('aborted'), { name: 'AbortError' })), true);
  assert.equal(isTemporary(Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 })), false);
  assert.equal(isTemporary(Object.assign(new Error('Needs Administrator'), { friendly: 'Needs Administrator' })), false);
});
