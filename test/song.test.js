'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const song = require('../cmds/song');

test('music aliases are prefix-bound and parse Arabic/English queries', () => {
  assert.equal(song._test.parseQuery('*song saquarema'), 'saquarema');
  assert.equal(song._test.parseQuery('*music free jazz'), 'free jazz');
  assert.equal(song._test.parseQuery('*اغنية mc mego نيران صديقة'), 'mc mego نيران صديقة');
  assert.equal(song._test.parseQuery('!موسيقى ambient', '!'), 'ambient');
  assert.equal(song._test.parseQuery('موسيقى ambient'), '');
  assert.equal(song._test.parseQuery('*song'), '');
});

test('accepts YouTube and SoundCloud results and rejects unsupported domains', () => {
  const yt = { title: 'YouTube audio', webpage_url: 'https://www.youtube.com/watch?v=abc', duration: 120 };
  const sc = { title: 'SoundCloud audio', webpage_url: 'https://soundcloud.com/artist/track', duration: 120 };
  assert.equal(song._test.parseSearchResult({ entries: [yt] }).title, 'YouTube audio');
  assert.equal(song._test.parseSearchResult({ entries: [sc] }).title, 'SoundCloud audio');
  assert.throws(() => song._test.parseSearchResult({ entries: [{ ...yt, duration: 800 }] }), /12 دقيقة/);
  assert.throws(() => song._test.parseSearchResult({ entries: [{ ...yt, webpage_url: 'https://example.com/' }] }), /مصدر غير مدعوم/);
});
