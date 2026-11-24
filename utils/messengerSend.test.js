'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { validateMessengerThreadID, sendMessengerPayload } = require('../utils/messengerSend');

test('accepts numeric Messenger IDs and rejects malformed IDs', () => {
  assert.equal(validateMessengerThreadID('123456789012'), '123456789012');
  assert.equal(validateMessengerThreadID(123456789), '123456789');
  assert.throws(() => validateMessengerThreadID('group-123'), /Invalid thread ID/);
  assert.throws(() => validateMessengerThreadID('\\123'), /Invalid thread ID/);
  assert.throws(() => validateMessengerThreadID(''), /Invalid thread ID/);
});

test('passes image attachment stream and exact group ID to FCA callback', async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const stream = Readable.from([bytes]);
  let observed;
  const fakeFca = {
    async sendMessage(payload, threadID, callback) {
      observed = { payload, threadID };
      const chunks = [];
      for await (const chunk of payload.attachment) chunks.push(chunk);
      callback(null, { threadID, messageID: 'mock-message-id', uploaded: Buffer.concat(chunks) });
    }
  };
  const result = await sendMessengerPayload(fakeFca, { attachment: stream }, '987654321');
  assert.equal(observed.threadID, '987654321');
  assert.equal(observed.payload.attachment, stream);
  assert.deepEqual(result.uploaded, bytes);
  assert.equal(result.messageID, 'mock-message-id');
});

test('returns FCA errors rather than reporting success', async () => {
  const fakeFca = { sendMessage(_payload, _threadID, callback) { callback(new Error('upload rejected')); } };
  await assert.rejects(sendMessengerPayload(fakeFca, { attachment: {} }, '12345'), /upload rejected/);
});

test('supports FCA promise response and timeout', async () => {
  assert.deepEqual(await sendMessengerPayload({ sendMessage: async () => ({ ok: true }) }, 'test', '123', 100), { ok: true });
  await assert.rejects(sendMessengerPayload({ sendMessage() {} }, 'test', '123', 10), /timed out/);
});
