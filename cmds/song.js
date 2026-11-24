'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const MAX_DURATION_SECONDS = 12 * 60;
const ALIASES = ['song', 'music', 'اغنية', 'أغنية', 'موسيقى'];

function parseQuery(body, prefix = '*') {
  const text = String(body || '').trim();
  const escaped = String(prefix || '*').replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
  const names = ALIASES.map(x => x.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&')).join('|');
  const match = text.match(new RegExp('^' + escaped + '(?:' + names + ')(?:\\s+|$)', 'i'));
  return match ? text.slice(match[0].length).trim() : '';
}

function parseSearchResult(data) {
  const video = Array.isArray(data?.entries) ? data.entries.find(Boolean) : data;
  if (!video || !video.title || !video.webpage_url || !Number.isFinite(Number(video.duration))) {
    throw new Error('لم أجد مقطعًا مناسبًا بهذا الاسم.');
  }
  if (Number(video.duration) > MAX_DURATION_SECONDS) {
    throw new Error('مدة المقطع أطول من 12 دقيقة؛ اختر نسخة أقصر.');
  }
  const parsed = new URL(video.webpage_url);
  const host = parsed.hostname.toLowerCase().replace(/^www\\./, '');
  if (!['youtube.com', 'music.youtube.com', 'youtu.be', 'm.youtube.com', 'soundcloud.com', 'on.soundcloud.com'].includes(host)) {
    throw new Error('نتيجة البحث من مصدر غير مدعوم.');
  }
  return video;
}

function runYtDlp(args, { timeoutMs = 120000, maxOutputBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(process.env.YT_DLP_PATH || 'yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('انتهت مهلة البحث أو التنزيل.'));
    }, timeoutMs);
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    }
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > maxOutputBytes) {
        child.kill('SIGKILL');
        finish(new Error('استجابة yt-dlp أكبر من الحد المسموح.'));
      }
    });
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.once('error', error => {
      if (error.code === 'ENOENT') finish(new Error('yt-dlp غير مثبت في بيئة التشغيل.'));
      else finish(error);
    });
    child.once('close', code => {
      if (settled) return;
      if (code !== 0) finish(new Error(stderr.trim().slice(-700) || 'فشل yt-dlp.'));
      else finish(null, { stdout, stderr });
    });
  });
}

async function searchVideo(query) {
  let lastError;
  for (const search of ['ytsearch1:' + query, 'scsearch1:' + query]) {
    try {
      const result = await runYtDlp([
        '--no-warnings', '--no-playlist', '--skip-download', '--dump-single-json',
        search.startsWith('ytsearch') ? '--extractor-args' : '',
        ...(search.startsWith('ytsearch') ? ['youtube:player_client=default'] : []),
        search
      ].filter(Boolean), { timeoutMs: 35000 });
      let data;
      try { data = JSON.parse(result.stdout); }
      catch { throw new Error('تعذرت قراءة نتيجة البحث.'); }
      return parseSearchResult(data);
    } catch (error) {
      lastError = error;
      const msg = String(error?.message || error).toLowerCase();
      if (search.startsWith('ytsearch') && /sign in|not a bot|captcha|confirm you|authentication|cookies/.test(msg)) {
        console.warn('SONG_YOUTUBE_BLOCKED: YouTube requires authentication; trying SoundCloud search.');
        continue;
      }
      if (search.startsWith('ytsearch')) continue;
    }
  }
  const reason = String(lastError?.message || '').toLowerCase();
  if (/sign in|not a bot|captcha|confirm you|authentication|cookies/.test(reason)) {
    throw new Error('YouTube يطلب التحقق من الحساب من خادم البوت، ولم نجد نسخة قابلة للتنزيل من مصدر بديل. جرّب اسمًا آخر أو ملفًا متاحًا للتنزيل.');
  }
  throw new Error('لم أجد مقطعًا متاحًا للتنزيل بهذا الاسم.');
}

async function downloadAudio(video, directory) {
  const template = path.join(directory, '%(id)s.%(ext)s');
  await runYtDlp([
    '--no-warnings', '--no-playlist', '--no-progress',
    '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '5',
    '--format', 'bestaudio/best', '--max-filesize', '15M',
    '--output', template, video.webpage_url
  ], { timeoutMs: 150000, maxOutputBytes: 512 * 1024 });
  const files = await fs.readdir(directory);
  const audioName = files.find(name => name.toLowerCase().endsWith('.mp3'));
  if (!audioName) throw new Error('لم ينتج yt-dlp ملف MP3. تأكد من توفر FFmpeg.');
  const audioPath = path.join(directory, audioName);
  const stat = await fs.stat(audioPath);
  if (!stat.isFile() || stat.size === 0) throw new Error('الملف الصوتي فارغ.');
  if (stat.size > MAX_AUDIO_BYTES) throw new Error('حجم الملف تجاوز 15 ميغابايت.');
  return audioPath;
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
  description: 'البحث عن مقطع متاح على YouTube أو SoundCloud وإرساله كملف MP3',
  _test: { parseQuery, parseSearchResult, runYtDlp, searchVideo, downloadAudio, callSendMessage, MAX_AUDIO_BYTES, MAX_DURATION_SECONDS },
  async execute(api, event) {
    const query = parseQuery(event?.body, event?.config?.prefix || '*');
    if (!query) {
      return api.sendMessage('🎵 اكتب اسم المقطع بعد الأمر.\nمثال: *موسيقى اسم الأغنية', event.threadID, event.messageID);
    }
    if (query.length > 180) {
      return api.sendMessage('⚠️ اسم البحث طويل جدًا؛ اختصره قليلًا.', event.threadID, event.messageID);
    }
    let directory;
    try {
      await api.sendMessage('🔎 أبحث عن المقطع وأجهّز الملف الصوتي…', event.threadID, event.messageID);
      const video = await searchVideo(query);
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-music-' + randomUUID() + '-'));
      const audioPath = await downloadAudio(video, directory);
      const title = String(video.title || query).replace(/[\r\n]+/g, ' ').slice(0, 150);
      await callSendMessage(api, {
        body: '🎵 ' + title + '\n📎 ملف MP3',
        attachment: createReadStream(audioPath)
      }, event);
    } catch (error) {
      console.error('SONG_COMMAND_FAILED', String(error?.message || error).slice(0, 240));
      await api.sendMessage(
        '❌ تعذّر تجهيز الأغنية: ' + String(error?.message || error).slice(0, 180),
        event.threadID, event.messageID
      );
    } finally {
      if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }
};
