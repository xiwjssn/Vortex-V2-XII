'use strict';

const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const net = require('node:net');

const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const MAX_DURATION_SECONDS = 12 * 60;
const ALIASES = ['song', 'music', 'اغنية', 'أغنية', 'موسيقى'];
const SEARCH_API = 'https://betadash-search-download.vercel.app/yt?search=';
const DOWNLOAD_API = 'https://nayan-video-downloader.vercel.app/ytdown?url=';

function parseQuery(body, prefix = '*') {
  const text = String(body || '').trim();
  const escaped = String(prefix || '*').replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
  const names = ALIASES.map(x => x.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&')).join('|');
  const match = text.match(new RegExp('^' + escaped + '(?:' + names + ')(?:\\s+|$)', 'i'));
  return match ? text.slice(match[0].length).trim() : '';
}

function normalizeSearchData(data) {
  const item = Array.isArray(data) ? data[0] : data;
  if (!item || typeof item.url !== 'string' || typeof item.title !== 'string' || !item.title.trim()) {
    throw new Error('لم أجد نتيجة مناسبة بهذا الاسم.');
  }
  const parsed = new URL(item.url);
  if (parsed.protocol !== 'https:' || !['youtube.com', 'www.youtube.com', 'music.youtube.com', 'youtu.be', 'm.youtube.com'].includes(parsed.hostname.toLowerCase())) {
    throw new Error('نتيجة البحث ليست رابط YouTube صالحًا.');
  }
  if (item.duration != null && Number.isFinite(Number(item.duration)) && Number(item.duration) > MAX_DURATION_SECONDS) {
    throw new Error('مدة المقطع أطول من 12 دقيقة؛ اختر نسخة أقصر.');
  }
  return {
    url: parsed.toString(),
    title: item.title.trim().slice(0, 180),
    channelName: String(item.channelName || item.channel || 'YouTube').slice(0, 100)
  };
}

function validatePublicHttpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('رابط ملف الصوت غير صالح.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('مصدر ملف الصوت غير آمن.');
  const host = url.hostname.toLowerCase().replace(/^\\[|\\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('تم رفض عنوان تنزيل غير عام.');
  }
  if (net.isIP(host)) {
    if (host === '127.0.0.1' || host === '::1' || host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.') || /^172\\.(1[6-9]|2[0-9]|3[01])\\./.test(host) || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) {
      throw new Error('تم رفض عنوان تنزيل محلي.');
    }
  }
  return url;
}

async function fetchJson(url, timeoutMs = 25000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'VORTEX-Messenger-Music/1.0' } });
  if (!response.ok) throw new Error('خدمة البحث أو التحميل غير متاحة حاليًا (HTTP ' + response.status + ').');
  const text = await response.text();
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('استجابة خدمة الموسيقى أكبر من الحد.');
  try { return JSON.parse(text); } catch { throw new Error('أعادت خدمة الموسيقى بيانات غير مفهومة.'); }
}

async function searchTrack(query) {
  const data = await fetchJson(SEARCH_API + encodeURIComponent(query));
  return normalizeSearchData(data);
}

async function resolveAudioUrl(track) {
  const data = await fetchJson(DOWNLOAD_API + encodeURIComponent(track.url), 35000);
  const audio = data?.data?.audio;
  if (typeof audio !== 'string') throw new Error('لم توفر خدمة التحميل رابط ملف صوتي.');
  return validatePublicHttpsUrl(audio).toString();
}

async function downloadAudio(audioUrl, directory) {
  let url = validatePublicHttpsUrl(audioUrl);
  let response;
  for (let redirects = 0; redirects <= 4; redirects++) {
    response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(90000), headers: { 'user-agent': 'VORTEX-Messenger-Music/1.0' } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location || redirects === 4) throw new Error('رابط تنزيل الصوت أعاد تحويلات كثيرة أو غير صالحة.');
      url = validatePublicHttpsUrl(new URL(location, url).toString());
      continue;
    }
    break;
  }
  if (!response.ok || !response.body) throw new Error('فشل تنزيل الملف الصوتي (HTTP ' + response.status + ').');
  if (Number(response.headers.get('content-length')) > MAX_AUDIO_BYTES) throw new Error('حجم الأغنية أكبر من 15 ميغابايت.');
  const filePath = path.join(directory, 'track.mp3');
  let total = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > MAX_AUDIO_BYTES) return callback(new Error('حجم الأغنية تجاوز 15 ميغابايت.'));
      callback(null, chunk);
    }
  });
  await pipeline(response.body, limiter, createWriteStream(filePath));
  const stat = await fs.stat(filePath);
  if (!stat.size) throw new Error('ملف الصوت فارغ.');
  return filePath;
}

async function callSendMessage(api, message, event) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => done(new Error('انتهت مهلة إرسال الملف إلى ماسنجر.')), 45000);
    function done(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    }
    try {
      api.sendMessage(message, event.threadID, event.messageID, done);
    } catch (error) { done(error); }
  });
}

module.exports = {
  name: 'song',
  aliases: ['music', 'اغنية', 'أغنية', 'موسيقى'],
  description: 'البحث عن أغنية وإرسالها كملف MP3 عبر خدمة بحث وتنزيل خارجية',
  _test: { parseQuery, normalizeSearchData, validatePublicHttpsUrl, callSendMessage, MAX_AUDIO_BYTES, MAX_DURATION_SECONDS },
  async execute(api, event) {
    const query = parseQuery(event?.body, event?.config?.prefix || '*');
    if (!query) return api.sendMessage('🎵 اكتب اسم الأغنية بعد الأمر.\\nمثال: *موسيقى اسم الأغنية', event.threadID, event.messageID);
    if (query.length > 180) return api.sendMessage('⚠️ اسم البحث طويل جدًا؛ اختصره قليلًا.', event.threadID, event.messageID);
    let directory;
    try {
      await api.sendMessage('🔎 أبحث عن الأغنية وأجهّز الملف الصوتي…', event.threadID, event.messageID);
      const track = await searchTrack(query);
      const audioUrl = await resolveAudioUrl(track);
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-song-' + randomUUID() + '-'));
      const audioPath = await downloadAudio(audioUrl, directory);
      await callSendMessage(api, {
        body: '🎵 ' + track.title + '\\n🎤 ' + track.channelName + '\\n📎 ملف MP3',
        attachment: createReadStream(audioPath)
      }, event);
    } catch (error) {
      console.error('SONG_COMMAND_FAILED', String(error?.message || error).slice(0, 220));
      await api.sendMessage('❌ تعذّر تجهيز الأغنية: ' + String(error?.message || 'الخدمة غير متاحة').slice(0, 160), event.threadID, event.messageID);
    } finally {
      if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }
};
