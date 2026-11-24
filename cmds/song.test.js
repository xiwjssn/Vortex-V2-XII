'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const song = require('./song');
const { parseQuery, normalizeSearchData, validatePublicHttpsUrl, callSendMessage, MAX_AUDIO_BYTES, MAX_DURATION_SECONDS } = song._test;

test('music aliases are prefix-bound and parse Arabic/English queries', () => {
  assert.equal(parseQuery('*موسيقى نغمة هادئة', '*'), 'نغمة هادئة');
  assert.equal(parseQuery('!music track name', '!'), 'track name');
  assert.equal(parseQuery('*song ambient', '*'), 'ambient');
  assert.equal(parseQuery('*اغنية اسم', '*'), 'اسم');
  assert.equal(parseQuery('موسيقى اسم', '*'), '');
  assert.equal(parseQuery('*موسيقى', '*'), '');
  assert.equal(parseQuery('.music ambient', '.'), 'ambient');
  assert.equal(parseQuery('+song ambient', '+'), 'ambient');
});

test('validates search API shape, YouTube URL and song duration', () => {
  const item = { title: 'Track title', url: 'https://www.youtube.com/watch?v=abc', channelName: 'Artist', duration: 180 };
  assert.equal(normalizeSearchData([item]).title, 'Track title');
  assert.equal(normalizeSearchData([item]).channelName, 'Artist');
  assert.throws(() => normalizeSearchData([]), /لم أجد/);
  assert.throws(() => normalizeSearchData([{ ...item, url: 'https://example.com/video' }]), /YouTube/);
  assert.throws(() => normalizeSearchData([{ ...item, duration: 800 }]), /12 دقيقة/);
});

test('rejects insecure, credentialed and local download URLs', () => {
  assert.equal(validatePublicHttpsUrl('https://cdn.example.org/audio.mp3').protocol, 'https:');
  assert.throws(() => validatePublicHttpsUrl('http://cdn.example.org/audio.mp3'), /غير آمن/);
  assert.throws(() => validatePublicHttpsUrl('https://localhost/file'), /غير عام/);
  assert.throws(() => validatePublicHttpsUrl('https://127.0.0.1/file'), /محلي/);
  assert.throws(() => validatePublicHttpsUrl('https://user:pass@host.example/file'), /غير آمن/);
});

test('enforces the configured audio and duration ceilings', () => {
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
      setTimeout(() => { callbackCalled = true; callback(null, { messageID: 'sent-1' }); }, 10);
      return Promise.resolve({ queued: true });
    }
  };
  await callSendMessage(api, { body: 'audio', attachment: {} }, { threadID: '123', messageID: 'reply-1' });
  assert.equal(callbackCalled, true);
});

test('propagates Messenger callback errors', async () => {
  const api = { sendMessage(_message, _threadID, _messageID, callback) { setImmediate(() => callback(new Error('attachment rejected'))); } };
  await assert.rejects(callSendMessage(api, { body: 'audio', attachment: {} }, { threadID: '123' }), /attachment rejected/);
});
