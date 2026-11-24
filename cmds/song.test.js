'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const song = require('./song');
const { parseQuery, isCreativeCommonsTrack, callSendMessage, MAX_AUDIO_BYTES } = song._test;

test('music alias is parsed only after the configured prefix', () => {
  assert.equal(parseQuery('*موسيقى نغمة هادئة', '*'), 'نغمة هادئة');
  assert.equal(parseQuery('!موسيقى track name', '!'), 'track name');
  assert.equal(parseQuery('*اغنية اسم', '*'), 'اسم');
  assert.equal(parseQuery('موسيقى اسم', '*'), '');
});

test('parses aliases and escapes a custom regex-special prefix', () => {
  assert.equal(parseQuery('.music ambient', '.'), 'ambient');
  assert.equal(parseQuery('+song ambient', '+'), 'ambient');
  assert.equal(parseQuery('*موسيقى', '*'), '');
});

test('accepts only secure audio URLs with a Creative Commons license URL', () => {
  assert.equal(isCreativeCommonsTrack({
    audiodownload: 'https://cdn.example/audio.mp3',
    license_ccurl: 'https://creativecommons.org/licenses/by/4.0/'
  }), true);
  assert.equal(isCreativeCommonsTrack({
    audiodownload: 'http://cdn.example/audio.mp3',
    license_ccurl: 'https://creativecommons.org/licenses/by/4.0/'
  }), false);
  assert.equal(isCreativeCommonsTrack({
    audiodownload: 'https://cdn.example/audio.mp3',
    license_ccurl: 'https://example.com/license'
  }), false);
  assert.equal(MAX_AUDIO_BYTES, 15 * 1024 * 1024);
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
      // Simulate the safety wrapper promise resolving immediately after queueing.
      return Promise.resolve({ queued: true });
    }
  };
  await callSendMessage(api, { body: 'audio', attachment: {} }, {
    threadID: '123', messageID: 'reply-1'
  });
  assert.equal(callbackCalled, true);
});

test('propagates Messenger callback errors for the audio attachment', async () => {
  const api = {
    sendMessage(_message, _threadID, _messageID, callback) {
      setImmediate(() => callback(new Error('attachment rejected')));
    }
  };
  await assert.rejects(
    callSendMessage(api, { body: 'audio', attachment: {} }, { threadID: '123' }),
    /attachment rejected/
  );
});
