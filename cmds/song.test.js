'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const song = require('./song');
const { parseQuery, parseSearchResult, callSendMessage, MAX_AUDIO_BYTES, MAX_DURATION_SECONDS } = song._test;

test('music command aliases are parsed only after the configured prefix', () => {
  assert.equal(parseQuery('*موسيقى نغمة هادئة', '*'), 'نغمة هادئة');
  assert.equal(parseQuery('!music track name', '!'), 'track name');
  assert.equal(parseQuery('*song ambient', '*'), 'ambient');
  assert.equal(parseQuery('*اغنية اسم', '*'), 'اسم');
  assert.equal(parseQuery('موسيقى اسم', '*'), '');
  assert.equal(parseQuery('*موسيقى', '*'), '');
});

test('parses custom regex-special prefixes safely', () => {
  assert.equal(parseQuery('.music ambient', '.'), 'ambient');
  assert.equal(parseQuery('+song ambient', '+'), 'ambient');
});

test('selects first search result and rejects invalid, long or non-YouTube results', () => {
  const valid = { title: 'Track', webpage_url: 'https://www.youtube.com/watch?v=abc', duration: 180 };
  assert.equal(parseSearchResult({ entries: [valid] }).title, 'Track');
  assert.throws(() => parseSearchResult({ entries: [] }), /لم أجد/);
  assert.throws(() => parseSearchResult({ ...valid, duration: 800 }), /12 دقيقة/);
  assert.throws(() => parseSearchResult({ ...valid, webpage_url: 'https://example.com/file' }), /YouTube/);
  assert.equal(MAX_AUDIO_BYTES, 15 * 1024 * 1024);
  assert.equal(MAX_DURATION_SECONDS, 720);
});

test('waits for FCA callback before confirming audio delivery', async () => {
  let callbackCalled = false;
  const api = {
    sendMessage(message, threadID, messageID, callback) {
      assert.equal(threadID, '123');
      assert.equal(messageID, 'reply-1');
      assert.ok(message.attachment);
      setTimeout(() => {
        callbackCalled = true;
        callback(null, { messageID: 'sent-1' });
      }, 10);
      return Promise.resolve({ queued: true });
    }
  };
  await callSendMessage(api, { body: 'audio', attachment: {} }, { threadID: '123', messageID: 'reply-1' });
  assert.equal(callbackCalled, true);
});

test('propagates Messenger callback errors for audio attachment', async () => {
  const api = {
    sendMessage(_message, _threadID, _messageID, callback) {
      setImmediate(() => callback(new Error('attachment rejected')));
    }
  };
  await assert.rejects(callSendMessage(api, { body: 'audio', attachment: {} }, { threadID: '123' }), /attachment rejected/);
});
