'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const song = require('../cmds/song');

test('legacy test suite verifies Arabic and English music aliases with the prefix', () => {
  assert.equal(song._test.parseQuery('*song saquarema'), 'saquarema');
  assert.equal(song._test.parseQuery('*music free jazz'), 'free jazz');
  assert.equal(song._test.parseQuery('*اغنية mc mego نيران صديقة'), 'mc mego نيران صديقة');
  assert.equal(song._test.parseQuery('!موسيقى ambient', '!'), 'ambient');
  assert.equal(song._test.parseQuery('موسيقى ambient'), '');
  assert.equal(song._test.parseQuery('*song'), '');
});

test('validates metadata from a YouTube search result and limits clip duration', () => {
  const track = { title: 'Test audio', webpage_url: 'https://www.youtube.com/watch?v=abc', duration: 120 };
  assert.equal(song._test.parseSearchResult({ entries: [track] }).title, 'Test audio');
  assert.throws(() => song._test.parseSearchResult({ entries: [{ ...track, duration: 800 }] }), /12 دقيقة/);
  assert.throws(() => song._test.parseSearchResult({ entries: [{ ...track, webpage_url: 'https://example.com/' }] }), /YouTube/);
});
