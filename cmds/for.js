'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CHANGE_DELAY_MS = 3000;
const GUARD_INTERVAL_MS = 3000;
const monitors = new Map();

function apiCall(api, method, ...args) {
  return new Promise((resolve, reject) => {
    if (!api || typeof api[method] !== 'function') return reject(new Error('API method unavailable: ' + method));
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      error ? reject(error instanceof Error ? error : new Error(String(error))) : resolve(value);
    };
    try {
      const result = api[method](...args, finish);
      if (result && typeof result.then === 'function') result.then(v => finish(null, v), finish);
    } catch (error) { finish(error); }
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function load(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[for] Load error:', error.message);
    return {};
  }
}

function save(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

function startGuard(api, file) {
  let state = monitors.get(file);
  if (!state) {
    state = { api, protectedGroups: load(file), busy: false, timer: null };
    monitors.set(file, state);
  } else {
    state.api = api;
  }
  if (state.timer) return state;

  state.timer = setInterval(async () => {
    if (state.busy || !state.api) return;
    state.busy = true;
    try {
      for (const [threadID, record] of Object.entries(state.protectedGroups)) {
        if (!record || typeof record.name !== 'string' || !Array.isArray(record.members)) continue;
        try {
          const info = await apiCall(state.api, 'getThreadInfo', threadID);
          const nicknames = info && info.nicknames && typeof info.nicknames === 'object' ? info.nicknames : null;
          // Do not assume all members changed if FCA omits nickname data.
          if (!nicknames) continue;
          for (const memberID of record.members) {
            if (String(nicknames[memberID] || '') === record.name) continue;
            try {
              await apiCall(state.api, 'changeNickname', record.name, String(memberID), String(threadID));
              await sleep(CHANGE_DELAY_MS);
            } catch (error) {
              console.warn('[for] Nickname restore failed:', String(error.message || error).slice(0, 160));
            }
          }
        } catch (error) {
          console.warn('[for] Guard check failed:', String(error.message || error).slice(0, 160));
        }
      }
    } finally { state.busy = false; }
  }, GUARD_INTERVAL_MS);
  state.timer.unref?.();
  return state;
}

module.exports = {
  name: 'فور',
  aliases: ['for'],
  description: 'توحيد كنيات أعضاء المجموعة وحمايتها',
  adminOnly: true,

  async execute(api, event) {
    const threadID = String(event.threadID || '');
    const config = event.config || {};
    const input = (Array.isArray(event.args) ? event.args : []).join(' ').trim();
    const file = path.join(config.dataDir || path.join(process.cwd(), 'data'), 'for-protected-nicknames.json');
    const state = startGuard(api, file);

    if (!threadID) return api.sendMessage('❌ تعذر تحديد المجموعة.', threadID, event.messageID);

    if (/^(?:إيقاف|ايقاف|stop)$/i.test(input)) {
      if (!state.protectedGroups[threadID]) {
        return api.sendMessage('ℹ️ لا توجد حماية كنيات مفعلة هنا.', threadID, event.messageID);
      }
      delete state.protectedGroups[threadID];
      save(file, state.protectedGroups);
      return api.sendMessage('🛑 تم إيقاف حماية الكنيات لهذه المجموعة.', threadID, event.messageID);
    }

    if (!input || input.length > 80) {
      return api.sendMessage('استخدم: ' + String(config.prefix || '*') + 'فور 2222\nإيقاف الحماية: ' + String(config.prefix || '*') + 'فور إيقاف', threadID, event.messageID);
    }

    const target = input;
    const info = await apiCall(api, 'getThreadInfo', threadID);
    const ids = Array.isArray(info?.participantIDs) ? info.participantIDs.map(String) : [];
    const botID = typeof api.getCurrentUserID === 'function' ? String(api.getCurrentUserID()) : '';
    const members = [...new Set(ids)].filter(id => id && id !== botID);
    if (!members.length) {
      return api.sendMessage('❌ لم أتمكن من قراءة أعضاء المجموعة.', threadID, event.messageID);
    }

    const record = { name: target, members };
    state.protectedGroups[threadID] = record;
    save(file, state.protectedGroups);

    let changed = 0;
    for (const memberID of members) {
      // Keep each member action separated to avoid a burst of account requests.
      await sleep(CHANGE_DELAY_MS);
      try {
        await apiCall(api, 'changeNickname', target, memberID, threadID);
        changed++;
      } catch (error) {
        console.warn('[for] Nickname update failed:', String(error.message || error).slice(0, 160));
      }
    }

    return api.sendMessage(
      '✅ تم ضبط الكنية على «' + target + '» للأعضاء: ' + changed + '/' + members.length + '\n' +
      '🛡️ الحماية مفعلة؛ يعيد البوت الكنية عند رصد تغييرها.\n' +
      '⏱️ الفاصل بين تعديلات الأعضاء 3 ثوانٍ.\n' +
      'لإيقافها: ' + String(config.prefix || '*') + 'فور إيقاف',
      threadID,
      event.messageID
    );
  }
};
