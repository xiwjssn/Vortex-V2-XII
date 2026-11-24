'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const song = require('../cmds/song');

test('prefix-bound music aliases', () => {
  assert.equal(song._test.parseQuery('*موسيقى اسم', '*'), 'اسم');
  assert.equal(song._test.parseQuery('!music ambient', '!'), 'ambient');
  assert.equal(song._test.parseQuery('موسيقى اسم', '*'), '');
});

test('normalizes the external search API response and rejects invalid results', () => {
  const item = { title: 'Song', url: 'https://www.youtube.com/watch?v=abc', channelName: 'Artist', duration: 90 };
  assert.equal(song._test.normalizeSearchData([item]).title, 'Song');
  assert.throws(() => song._test.normalizeSearchData([]), /لم أجد/);
  assert.throws(() => song._test.normalizeSearchData([{ ...item, url: 'https://example.com/' }]), /YouTube/);
  assert.throws(() => song._test.normalizeSearchData([{ ...item, duration: 900 }]), /12 دقيقة/);
});

test('rejects unsafe audio URLs', () => {
  assert.equal(song._test.validatePublicHttpsUrl('https://cdn.example.org/song.mp3').protocol, 'https:');
  assert.throws(() => song._test.validatePublicHttpsUrl('http://cdn.example.org/song.mp3'), /غير آمن/);
  assert.throws(() => song._test.validatePublicHttpsUrl('https://localhost/song.mp3'), /غير عام/);
  assert.throws(() => song._test.validatePublicHttpsUrl('https://127.0.0.1/song.mp3'), /محلي/);
});
