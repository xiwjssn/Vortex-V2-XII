const test = require('node:test');
const assert = require('node:assert/strict');
const { ReconnectManager } = require('../utils/reconnect');

const logger = { warn() {}, error() {} };

test('stops reconnecting immediately when login requires checkpoint/session verification', async () => {
  let calls = 0;
  const manager = new ReconnectManager({
    connect: async () => {
      calls += 1;
      throw new Error('Facebook checkpoint: login approval required');
    },
    logger,
    baseMs: 100,
    maxMs: 100,
    random: () => 0
  });

  manager.start();
  manager.schedule();
  await new Promise(resolve => setTimeout(resolve, 160));

  assert.equal(calls, 1);
  assert.equal(manager.stopped, true);
  assert.equal(manager.timer, null);
  manager.stop();
});

test('continues delayed reconnect after a temporary network error', async () => {
  let calls = 0;
  const manager = new ReconnectManager({
    connect: async () => {
      calls += 1;
      if (calls === 1) throw new Error('Temporary network timeout');
      return { status: 'connected' };
    },
    logger,
    baseMs: 100,
    maxMs: 100,
    random: () => 0
  });

  manager.start();
  manager.schedule();
  await new Promise(resolve => setTimeout(resolve, 300));

  assert.equal(calls, 2);
  assert.equal(manager.attempts, 0);
  manager.stop();
});
