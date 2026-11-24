'use strict';

function validateMessengerThreadID(threadID) {
  const id = String(threadID ?? '');
  if (!/^\d{1,40}$/.test(id)) throw new Error('Invalid thread ID.');
  return id;
}

function sendMessengerPayload(api, payload, threadID, timeoutMs = 45000) {
  const targetID = validateMessengerThreadID(threadID);
  if (!api || typeof api.sendMessage !== 'function') {
    return Promise.reject(new Error('FCA sendMessage is unavailable.'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Messenger send timed out; FCA did not confirm delivery.')), timeoutMs);
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(new Error(String(error.message || error).slice(0, 220)));
      else resolve(result ?? null);
    }
    try {
      const returned = api.sendMessage(payload, targetID, finish);
      if (returned && typeof returned.then === 'function') {
        returned.then(value => finish(null, value), finish);
      }
    } catch (error) {
      finish(error);
    }
  });
}

module.exports = { validateMessengerThreadID, sendMessengerPayload };
