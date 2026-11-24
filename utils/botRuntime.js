const fs = require('node:fs/promises');
const path = require('node:path');
const { loadCommands } = require('./commandLoader');
const { validateAppState } = require('./appState');
const { atomicWrite } = require('./atomicFile');
const { ReconnectManager } = require('./reconnect');
const { AppStateRefreshManager } = require('./appStateRefresh');
const { createHumanWriter } = require('./humanWriter');
const { isAuthorizedSender } = require('./accessControl');
const { isSessionAuthError } = require('./sessionErrors');

function createBotRuntime({ config, logger }) {
  const cmdsDir = path.join(__dirname, '..', 'cmds');
  let loaded = loadCommands(cmdsDir, logger);
  let api = null;
  let status = 'offline';
  let lastError = null;
  let lastConnect = null;
  let lastDisconnect = null;
  let startedAt = Date.now();
  let connecting = false;
  let appStatePresent = false;
  let appState = null;
  let sessionCleared = false;
  let appStateRefreshManager;
  let reconnectManager;
  let mqttStatus = 'offline';
  let manualDisconnect = false;
  let requiresSessionUpdate = false;
  let sessionHealth = 'unknown';
  let sessionMessage = 'Session status has not been verified yet.';
  async function initializeAppStateRefreshManager() {
    if (appStateRefreshManager) return;
    appStateRefreshManager = new AppStateRefreshManager({
      dataDir: config.dataDir,
      getApi: () => api,
      ensureConnected: async () => { if (!api) await runtime.connect(); },
      setAppState: value => { appState = value; appStatePresent = true; },
      logger
    });
    await appStateRefreshManager.init();
  }
  function setSessionAttention(reason) {
    requiresSessionUpdate = true;
    sessionHealth = 'needs-attention';
    sessionMessage = 'Facebook may have expired this session or requires account verification. Update AppState in the dashboard, then connect again.';
    lastError = sessionMessage;
    reconnectManager?.stop();
    logger.warn('SESSION_REAUTH_REQUIRED', { reason: 'authentication-or-checkpoint-error' });
  }
  const humanWriter = createHumanWriter({
    logger, minIntervalMs: 6000, globalIntervalMs: 4000, duplicateWindowMs: 60000, maxPerMinute: 5, circuitPauseMs: 60 * 60 * 1000, maxConsecutiveFailures: 2,
    onSafetyStop: ({ type, reason }) => {
      logger.warn('OUTBOUND_AUTOMATION_STOPPED', { type, reason });
      if (type === 'session' && runtime) {
        runtime.disconnected('checkpoint/login required after outbound send error').catch(() => {});
      }
    }
  });
  const seenCommandMessages = new Map();
  // Runtime support used by cmds/vortex.js. This is not a separate repeat command.
  const repeatingJobs = new Map();
  function stopRepeatingMessage(threadID) {
    const key = String(threadID || '');
    const job = repeatingJobs.get(key);
    if (!job) return { stopped: false };
    clearInterval(job.timer);
    repeatingJobs.delete(key);
    return { stopped: true };
  }
  function startRepeatingMessage({ threadID, senderID, messages, intervalMs, inactivityMs }) {
    const key = String(threadID || '');
    if (!key || status !== 'connected' || !api) return { started: false, reason: 'offline' };
    if (repeatingJobs.has(key)) return { started: false, reason: 'already-running' };
    if (!Array.isArray(messages) || !messages.length ||
        !Number.isSafeInteger(intervalMs) || intervalMs < 15000 || intervalMs > 86400000) {
      return { started: false, reason: 'invalid' };
    }
    const job = {
      senderID: String(senderID || ''),
      messages: messages.map(value => String(value || '').trim()).filter(Boolean),
      intervalMs,
      inactivityMs: Number.isSafeInteger(inactivityMs) && inactivityMs >= 60000 ? inactivityMs : 16 * 60 * 1000,
      lastOtherActivityAt: Date.now(),
      index: 0,
      sending: false,
      timer: null
    };
    if (!job.messages.length) return { started: false, reason: 'invalid' };
    job.timer = setInterval(async () => {
      if (repeatingJobs.get(key) !== job || job.sending) return;
      if (Date.now() - job.lastOtherActivityAt >= job.inactivityMs) {
        stopRepeatingMessage(key);
        return;
      }
      if (!api || status !== 'connected') {
        stopRepeatingMessage(key);
        return;
      }
      job.sending = true;
      try {
        await humanWriter.wrap(api).sendMessage(job.messages[job.index++ % job.messages.length], key);
      } catch (error) {
        logger.warn('VORTEX_REPEAT_SEND_FAILED', { threadID: key, error: String(error?.message || error).slice(0, 160) });
        stopRepeatingMessage(key);
      } finally {
        job.sending = false;
      }
    }, intervalMs);
    job.timer.unref?.();
    repeatingJobs.set(key, job);
    return { started: true };
  }
  async function callMessengerApi(method,args,timeoutMs=15000){
    if(!api||typeof api[method]!=='function')throw new Error('FCA method unavailable: '+method);
    return new Promise((resolve,reject)=>{let done=false;const timer=setTimeout(()=>finish(new Error(method+' timed out.')),timeoutMs);
      function finish(error,value){if(done)return;done=true;clearTimeout(timer);error?reject(new Error(String(error.message||error).slice(0,220))):resolve(value);}
      try{const result=api[method](...args,finish);if(result&&typeof result.then==='function')result.then(v=>finish(null,v),finish);else if(result!==undefined&&api[method].length<=args.length)finish(null,result);}catch(e){finish(e);}
    });
  }
  const runtime = {
    startRepeatingMessage,
    stopRepeatingMessage,
    getState() {
      return {
        bot: config.botName, prefix: config.prefix, status, fcaStatus: status, mqttStatus,
        connected: status === 'connected', uptimeMs: Date.now() - startedAt,
        sessionHealth, sessionMessage, requiresSessionUpdate,
        commands: loaded.unique.length,
        lastConnection: lastConnect, lastDisconnect, lastError,
        appStateConfigured: appStatePresent,
        appStateRefresh: appStateRefreshManager ? appStateRefreshManager.getState() : {
          successCount: 0, failureCount: 0, lastAttemptAt: null, lastSuccessAt: null,
          lastFailureAt: null, lastError: null, nextRefreshAt: null, refreshing: false,
          intervalMs: 3 * 60 * 60 * 1000
        },
        outboundProtection: humanWriter.getState(), botID: null, version: require('../package.json').version
      };
    },
    getCommands() {
      return loaded.unique.map(c => ({
        name: c.name, aliases: c.aliases, description: c.description || '',
        adminOnly: !!c.adminOnly, file: c.file, status: 'loaded'
      }));
    },
    getCommandSource(name) {
      const c = loaded.unique.find(x => x.name === name || x.aliases.includes(name));
      if (!c) throw new Error('Command not found');
      return require('node:fs').readFileSync(path.join(cmdsDir, c.file), 'utf8');
    },
    refreshCommands() {
      loaded = loadCommands(cmdsDir, logger);
      return { count: loaded.unique.length, errors: loaded.errors };
    },
    async setAdminIDs(ids) {
      if (!Array.isArray(ids) || ids.some(id => !/^\d{1,30}$/.test(String(id)))) throw new Error('Invalid admin IDs');
      const next = [...new Set(ids.map(String).filter(id => !(config.ownerIDs || [config.ownerID]).includes(id)))];
      if (next.length > 20) throw new Error('Maximum of 20 regular Admins reached');
      config.adminIDs = next;
      await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
      await atomicWrite(path.join(config.dataDir, 'settings.json'), JSON.stringify({
        botName: config.botName, prefix: config.prefix, language: config.language,
        ownerIDs: config.ownerIDs || (config.ownerID ? [config.ownerID] : []), adminIDs: config.adminIDs
      }, null, 2), 0o600);
      return { admins: [...config.adminIDs] };
    },
    async setOwnerIDs(ids) {
      if (!Array.isArray(ids) || ids.some(id => !/^\d{1,30}$/.test(String(id)))) throw new Error('Invalid Owner IDs');
      const next = [...new Set(ids.map(String))];
      if (next.length < 1 || next.length > 3) throw new Error('Owner list must contain 1 to 3 IDs');
      const oldOwners = config.ownerIDs || (config.ownerID ? [config.ownerID] : []);
      const oldOwnerID = config.ownerID;
      const oldAdmins = config.adminIDs;
      config.ownerIDs = next;
      config.ownerID = next[0];
      config.adminIDs = config.adminIDs.filter(id => !next.includes(id));
      await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
      try {
        await atomicWrite(path.join(config.dataDir, 'settings.json'), JSON.stringify({
          botName: config.botName, prefix: config.prefix, language: config.language,
          ownerIDs: config.ownerIDs, adminIDs: config.adminIDs
        }, null, 2), 0o600);
      } catch (error) {
        config.ownerIDs = oldOwners; config.ownerID = oldOwnerID; config.adminIDs = oldAdmins;
        throw error;
      }
      return { owners: [...config.ownerIDs], ownerID: config.ownerID, admins: [...config.adminIDs] };
    },
    async saveAppState(raw, connect = false) {
      const parsed = validateAppState(raw);
      const file = path.join(config.dataDir, 'appstate.json');
      await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
      await atomicWrite(file, JSON.stringify(parsed), 0o600);
      await fs.rm(path.join(config.dataDir, '.appstate-cleared'), { force: true });
      appState = parsed;
      appStatePresent = true;
      sessionCleared = false;
      humanWriter.resetProtection();
      await initializeAppStateRefreshManager();
      requiresSessionUpdate = false;
      sessionHealth = 'checking';
      sessionMessage = 'New AppState saved. Checking the session connection.';
      lastError = null;
      if (connect) await runtime.connect();
      return { valid: true, connected: status === 'connected' };
    },
    async connect() {
      if (connecting || status === 'connected') return { status, mqttStatus };
      if (requiresSessionUpdate) return { status: 'needs-attention', mqttStatus, sessionHealth, sessionMessage };
      if (reconnectManager && manualDisconnect) { reconnectManager.start(); manualDisconnect = false; }
      connecting = true;
      status = 'connecting';
      mqttStatus = 'connecting';
      lastError = null;
      try {
        if (!appState) {
          try { await fs.access(path.join(config.dataDir, '.appstate-cleared')); sessionCleared = true; } catch {}
          if (sessionCleared) throw new Error('No AppState saved. Add a new session in the dashboard.');
          let raw = '';
          try { raw = await fs.readFile(path.join(config.dataDir, 'appstate.json'), 'utf8'); } catch {}
          if (!raw && config.appStateJson) raw = config.appStateJson;
          if (!raw && config.appStateFile) {
            try { raw = await fs.readFile(config.appStateFile, 'utf8'); } catch {}
          }
          if (!raw) throw new Error('No AppState configured');
          appState = validateAppState(raw);
          appStatePresent = true;
        }
        const mod = require('@dongdev/fca-unofficial');
        const login = typeof mod === 'function' ? mod : (mod.login || mod.default?.login || mod.default);
        if (typeof login !== 'function') throw new Error('Installed FCA package does not expose a supported login() API');
        await new Promise((resolve, reject) => {
          let settled = false;
          const timeout = setTimeout(() => finish(new Error('FCA login timed out')), 30000);
          function finish(err, value) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            err ? reject(err) : resolve(value);
          }
          try {
            login({ appState }, { listenEvents: true, autoReconnect: false, logLevel: 'error' }, (err, client) => {
              if (err) return finish(new Error('FCA login failed: ' + String(err.message || err).slice(0, 300)));
              if (!client || typeof client.listenMqtt !== 'function') return finish(new Error('FCA returned an unsupported client'));
              api = client;
              try {
                client.setOptions?.({ listenEvents: true, autoReconnect: false, logLevel: 'error' });
                const listener = client.listenMqtt((e, event) => {
                  if (e) {
                    logger.warn('FCA_EVENT_ERROR', { error: isSessionAuthError(e) ? 'authentication-or-checkpoint-error' : String(e.message || e).slice(0, 200) });
                    if (api === client) runtime.disconnected(e.message || 'mqtt-event-error');
                    return;
                  }
                  if (event) {
                    mqttStatus = 'connected';
                    runtime.handleEvent(event).catch(x => logger.error('EVENT_HANDLER_FAILED', { error: String(x.message || x).slice(0, 200) }));
                  }
                });
                if (listener?.on) {
                  listener.on('error', e => {
                    mqttStatus = 'error';
                    logger.warn('MQTT_ERROR', { error: isSessionAuthError(e) ? 'authentication-or-checkpoint-error' : String(e.message || e).slice(0, 200) });
                    if (api === client) runtime.disconnected(e.message || 'mqtt-listener-error');
                  });
                  listener.on('close', () => {
                    mqttStatus = 'offline';
                    if (api === client) runtime.disconnected('mqtt-close');
                  });
                  listener.on('end', () => {
                    mqttStatus = 'offline';
                    if (api === client) runtime.disconnected('mqtt-end');
                  });
                }
                mqttStatus = 'connected';
              } catch (e) { return finish(e); }
              status = 'connected';
              sessionHealth = 'healthy';
              sessionMessage = 'The FCA session is connected. Facebook presence may still be controlled by Facebook.';
              requiresSessionUpdate = false;
              lastConnect = new Date().toISOString();
              lastError = null;
              finish(null, client);
            });
          } catch (e) { finish(e); }
        });
        return { status };
      } catch (e) {
        mqttStatus = 'offline';
        if (isSessionAuthError(e)) {
          setSessionAttention(e);
          status = 'needs-attention';
        } else {
          status = 'offline';
          sessionHealth = 'disconnected';
          sessionMessage = 'The connection failed. The bot will retry with a delay; check logs if it continues.';
          lastError = String(e.message || e).slice(0, 300);
        }
        lastDisconnect = new Date().toISOString();
        logger.error('FCA_CONNECT_FAILED', { error: requiresSessionUpdate ? 'authentication-or-checkpoint-error' : lastError });
        throw e;
      } finally {
        connecting = false;
      }
    },
    async disconnected(reason) {
      if (!api && (status === 'offline' || requiresSessionUpdate)) return;
      lastDisconnect = new Date().toISOString();
      mqttStatus = 'offline';
      api = null;
      if (isSessionAuthError(reason)) {
        setSessionAttention(reason);
        status = 'needs-attention';
      } else {
        status = 'offline';
        sessionHealth = 'disconnected';
        sessionMessage = 'The connection was lost. Automatic reconnection will retry with increasing delays.';
        lastError = String(reason || 'connection lost').slice(0, 200);
      }
      logger.warn('FCA_DISCONNECTED', { reason: requiresSessionUpdate ? 'authentication-or-checkpoint-error' : lastError });
      if (!manualDisconnect && !requiresSessionUpdate) reconnectManager?.schedule();
    },
    async handleEvent(event) {
      if (!event || !['message', 'message_reply', 'messageCreate'].includes(event.type) || !event.body || !event.threadID) return;
      const body = String(event.body).trim();
      const activeRepeat = repeatingJobs.get(String(event.threadID));
      if (activeRepeat && String(event.senderID || '') !== activeRepeat.senderID) {
        activeRepeat.lastOtherActivityAt = Date.now();
      }
      // Strict allow-list: only IDs configured as Owners/Admins may invoke commands or answer command prompts.
      // This intentionally keeps ordinary group messages from triggering command handlers or replies.
      if (!isAuthorizedSender(event.senderID, config.ownerIDs || [config.ownerID], config.adminIDs || [])) return;
      // Stateful commands may consume plain numeric/confirmation replies without the command prefix.
      const replySender = String(event.senderID || '');
      const replyIsOwner = (config.ownerIDs || [config.ownerID]).filter(Boolean).includes(replySender);
      const replyIsAdmin = replyIsOwner || config.adminIDs.includes(replySender);
      const replyContext = { ...event, args: [], commandName: '', startedAt: Date.now(), config, runtime, isOwner: replyIsOwner, isAdmin: replyIsAdmin };
      for (const command of loaded.unique) {
        if (typeof command.handleReply !== 'function') continue;
        try {
          const handled = await command.handleReply(humanWriter.wrap(api), replyContext);
          if (handled) return;
        } catch (error) {
          logger.warn('COMMAND_REPLY_HANDLER_FAILED', { name: command.name, error: String(error?.message || error).slice(0, 180) });
          return;
        }
      }
      // All commands, including repeating-message controls, must use the dashboard-configured prefix.
      if (!body.startsWith(config.prefix)) return;
      const commandText = body.slice(config.prefix.length).trim();
      const [rawName, ...args] = commandText.split(/\s+/);
      if (!rawName) return;
      const cmd = loaded.commands.get(rawName.toLowerCase());
      if (!cmd) return;
      const sender = String(event.senderID || '');
      const isOwner = (config.ownerIDs || [config.ownerID]).filter(Boolean).includes(sender);
      const isAdmin = isOwner || config.adminIDs.includes(sender);
      if (event.messageID) {
        const now = Date.now();
        for (const [key, at] of seenCommandMessages) if (now - at > 300000) seenCommandMessages.delete(key);
        const dedupeKey = String(event.threadID) + ':' + String(event.messageID);
        if (seenCommandMessages.has(dedupeKey)) {
          logger.warn('DUPLICATE_COMMAND_SUPPRESSED', { command: cmd.name, threadID: String(event.threadID) });
          return;
        }
        seenCommandMessages.set(dedupeKey, now);
        while (seenCommandMessages.size > 2000) {
          const oldestKey = seenCommandMessages.keys().next().value;
          if (oldestKey === undefined) break;
          seenCommandMessages.delete(oldestKey);
        }
      }
      // Give every recognized command a natural typing pause before it responds.
      // FCA exposes sendTypingIndicator(threadID, callback) on supported versions.
      try {
        if (typeof api?.sendTypingIndicator === 'function') {
          api.sendTypingIndicator(event.threadID, () => {});
        }
      } catch (error) {
        logger.warn('TYPING_INDICATOR_FAILED', { error: String(error?.message || error).slice(0, 120) });
      }
      const typingDelayMs = 4000 + Math.floor(Math.random() * 2001);
      await new Promise(resolve => setTimeout(resolve, typingDelayMs));

      if (cmd.adminOnly && !isAdmin) {
        humanWriter.wrap(api).sendMessage('⛔ هذا الأمر للمسؤولين فقط.', event.threadID, event.messageID).catch(() => {});
        return;
      }
      const ctx = { ...event, args, commandName: rawName, startedAt: Date.now(), config, runtime, isOwner, isAdmin };
      try {
        await cmd.execute(humanWriter.wrap(api), ctx);
        logger.command('COMMAND_OK', { name: cmd.name, senderID: sender, role: isOwner ? 'owner' : isAdmin ? 'admin' : 'user' });
      } catch (e) {
        logger.error('COMMAND_FAILED', { name: cmd.name, error: String(e.message || e).slice(0, 200) });
      }
    },
    async disconnect() {
      manualDisconnect = true;
      reconnectManager?.stop();
      if (api && typeof api.logout === 'function') {
        try { await api.logout(); } catch (e) { logger.warn('FCA_LOGOUT_FAILED', { error: e.message }); }
      }
      api = null;
      status = 'offline';
      mqttStatus = 'offline';
      lastDisconnect = new Date().toISOString();
      return { status, mqttStatus };
    },
    async clearAppStateSession() {
      if (appStateRefreshManager) {
        await appStateRefreshManager.stopAndWait();
        appStateRefreshManager = null;
      }
      await runtime.disconnect();
      const appStateFile = path.join(config.dataDir, 'appstate.json');
      const refreshStatsFile = path.join(config.dataDir, 'appstate-refresh-stats.json');
      await fs.rm(appStateFile, { force: true });
      await fs.rm(refreshStatsFile, { force: true });
      await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
      await atomicWrite(path.join(config.dataDir, '.appstate-cleared'), new Date().toISOString(), 0o600);
      appState = null;
      appStatePresent = false;
      config.appStateJson = '';
      config.appStateFile = '';
      sessionCleared = true;
      requiresSessionUpdate = false;
      sessionHealth = 'no-session';
      sessionMessage = 'Session removed. Paste a new AppState to connect again.';
      lastError = null;
      lastConnect = null;
      lastDisconnect = null;
      mqttStatus = 'offline';
      startedAt = Date.now();
      seenCommandMessages.clear();
      logger.warn('APPSTATE_SESSION_REMOVED', { localSessionDataRemoved: true });
      return { status: 'offline', appStateConfigured: false, sessionCleared: true };
    },
    async refreshAppStateNow() {
      if (!appStateRefreshManager) throw new Error('AppState refresh manager is not ready');
      return appStateRefreshManager.refresh({ manual: true });
    },
    async stop() {
      for (const threadID of repeatingJobs.keys()) stopRepeatingMessage(threadID);
      appStateRefreshManager?.stop();
      await runtime.disconnect();
    },
    async start() {
      try {
        await fs.access(path.join(config.dataDir, '.appstate-cleared'));
        sessionCleared = true;
        appStatePresent = false;
        sessionHealth = 'no-session';
        sessionMessage = 'Session removed. Paste a new AppState to connect again.';
      } catch {
        await initializeAppStateRefreshManager();
      }
      reconnectManager = new ReconnectManager({
        connect: () => runtime.connect(), logger,
        baseMs: config.connection?.baseBackoffMs || 2000,
        maxMs: config.connection?.maxBackoffMs || 60000
      });
      reconnectManager.start();
      manualDisconnect = false;
      try { await runtime.connect(); } catch { if (appStatePresent && !sessionCleared && !requiresSessionUpdate) reconnectManager.schedule(); }
    },
    async listMessengerThreads(folder = 'inbox') {
      if (!api || status !== 'connected') throw new Error('Connect the account with a valid AppState first.');
      if (typeof api.getThreadList !== 'function') throw new Error('This FCA version does not support listing Messenger threads.');
      const tags = { inbox: ['INBOX'], requests: ['PENDING'], spam: ['OTHER'] };
      if (!Object.prototype.hasOwnProperty.call(tags, folder)) throw new Error('Invalid Messenger folder.');
      return new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => finish(new Error('Messenger request timed out.')), 15000);
        function finish(error, value) {
          if (done) return; done = true; clearTimeout(timer);
          error ? reject(new Error(String(error.message || error).slice(0, 220))) : resolve(Array.isArray(value) ? value : []);
        }
        try {
          const result = api.getThreadList(40, null, tags[folder], finish);
          if (result && typeof result.then === 'function') result.then(value => finish(null, value), finish);
        } catch (error) { finish(error); }
      });
    },
    async getMessengerHistory(threadID, limit = 40) {
      if (!api || status !== 'connected') throw new Error('Connect the account with a valid AppState first.');
      if (!/^\d{1,40}$/.test(String(threadID))) throw new Error('Invalid thread ID.');
      if (typeof api.getThreadHistory !== 'function') throw new Error('This FCA version does not support conversation history.');
      return new Promise((resolve, reject) => {
        let done = false; const timer = setTimeout(() => finish(new Error('Messenger history request timed out.')), 15000);
        function finish(error, value) {
          if (done) return; done = true; clearTimeout(timer);
          error ? reject(new Error(String(error.message || error).slice(0, 220))) : resolve(Array.isArray(value) ? value : []);
        }
        try {
          const result = api.getThreadHistory(String(threadID), Math.max(1, Math.min(60, Number(limit) || 40)), null, finish);
          if (result && typeof result.then === 'function') result.then(value => finish(null, value), finish);
        } catch (error) { finish(error); }
      });
    },
    async sendMessengerReply(threadID, message, options = {}) {
      if (!api || status !== 'connected') throw new Error('Connect the account with a valid AppState first.');
      const targetID = String(threadID);
      if (!/^\\d{1,40}$/.test(targetID)) throw new Error('Invalid thread ID.');
      if (typeof message !== 'string' || message.length > 2000) throw new Error('Message must be 2000 characters or fewer.');
      const body = message.trim();
      const imageData = typeof options.imageData === 'string' ? options.imageData : '';
      let attachmentPath = null;
      let payload = body;
      if (imageData) {
        const match = imageData.match(/^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=]+)$/);
        if (!match) throw new Error('صيغة الصورة غير صالحة. أعد اختيار الصورة.');
        const mime = match[1].toLowerCase();
        const buffer = Buffer.from(match[2], 'base64');
        if (!buffer.length || buffer.length > 5 * 1024 * 1024) throw new Error('حجم الصورة يجب ألا يتجاوز 5 MB.');
        const extension = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' }[mime];
        const dir = path.join(config.dataDir, 'messenger-uploads');
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        attachmentPath = path.join(dir, require('node:crypto').randomUUID() + extension);
        await fs.writeFile(attachmentPath, buffer, { mode: 0o600, flag: 'wx' });
        payload = { attachment: require('node:fs').createReadStream(attachmentPath) };
        if (body) payload.body = body;
      } else if (!body) {
        throw new Error('اكتب رسالة أو اختر صورة لإرسالها.');
      }
      if (options.silent === true && payload && typeof payload === 'object') payload.isSilent = true;
      return new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => finish(new Error('انتهت مهلة إرسال Messenger. لم يصل تأكيد من FCA.')), 45000);
        async function finish(error, value) {
          if (done) return; done = true; clearTimeout(timer);
          if (attachmentPath) { try { await fs.unlink(attachmentPath); } catch {} }
          error ? reject(new Error(String(error.message || error).slice(0, 220))) : resolve({ sent: true, result: value || null });
        }
        try {
          const result = api.sendMessage(payload, targetID, finish);
          if (result && typeof result.then === 'function') result.then(value => finish(null, value), finish);
        } catch (error) { finish(error); }
      });
    },
    async getMessengerGroupInfo(threadID) {
      if(!api||status!=='connected')throw new Error('Connect the account with a valid AppState first.');
      const id=String(threadID||'');if(!/^\d{1,40}$/.test(id))throw new Error('Invalid thread ID.');
      const info=await callMessengerApi('getThreadInfo',[id]);
      const normalizeID=value=>{if(value==null)return'';if(typeof value==='object')return String(value.id||value.userID||value.uid||value.actorID||value.user_id||'');return String(value);};
      const participantsSource=Array.isArray(info.participantIDs)?info.participantIDs:Object.keys(info.participantIDs||{});
      const participants=[...new Set(participantsSource.map(normalizeID).filter(uid=>/^[0-9]{1,40}$/.test(uid)))].slice(0,1000);
      const adminSource=Array.isArray(info.adminIDs)?info.adminIDs:(info.adminIDs&&typeof info.adminIDs==='object'?Object.entries(info.adminIDs).flatMap(([key,value])=>value===true?key:(normalizeID(value)||key)):[]);
      const admins=[...new Set(adminSource.map(normalizeID).filter(uid=>/^[0-9]{1,40}$/.test(uid)))];
      let botID='';try{botID=String(await callMessengerApi('getCurrentUserID',[]));}catch{}
      const raw=Array.isArray(info.userInfo)?info.userInfo:Object.entries(info.userInfo||{}).map(([key,value])=>({id:key,...value}));
      const names=new Map(raw.map(u=>[normalizeID(u),String(u.name||u.fullName||u.firstName||u.displayName||'')]).filter(([uid])=>uid));
      if(participants.some(uid=>!names.has(uid))&&typeof api.getUserInfo==='function'){try{const more=await callMessengerApi('getUserInfo',[participants]);for(const u of(Array.isArray(more)?more:Object.values(more||{}))){const uid=normalizeID(u),name=String(u.name||u.fullName||u.firstName||u.displayName||'');if(uid&&name)names.set(uid,name);}}catch{}}
      return{threadID:id,threadName:String(info.threadName||''),isGroup:!!info.isGroup||participants.length>2,botID,isBotAdmin:!!botID&&admins.includes(botID),admins:participants.filter(uid=>admins.includes(uid)).map(uid=>({id:uid,name:names.get(uid)||''})),members:participants.filter(uid=>!admins.includes(uid)).map(uid=>({id:uid,name:names.get(uid)||''})),participantCount:participants.length};
    },
    async addMessengerMember(threadID,userID){
      const id=String(threadID||''),uid=String(userID||'').trim();if(!/^\d{1,40}$/.test(id)||!/^\d{1,40}$/.test(uid))throw new Error('Enter a valid numeric Messenger user ID.');
      const info=await runtime.getMessengerGroupInfo(id);if(!info.isGroup)throw new Error('Only group chats support member management.');if(!info.isBotAdmin)throw new Error('Bot must be a group admin.');if(uid===info.botID)throw new Error('Bot is already in this group.');
      await callMessengerApi('addUserToGroup',[uid,id]);return{ok:true,added:uid};
    },
    async removeMessengerMember(threadID,userID){
      const id=String(threadID||''),uid=String(userID||'').trim();if(!/^\d{1,40}$/.test(id)||!/^\d{1,40}$/.test(uid))throw new Error('Invalid group/member ID.');
      const info=await runtime.getMessengerGroupInfo(id);if(!info.isGroup)throw new Error('Only group chats support member management.');if(!info.isBotAdmin)throw new Error('Bot must be a group admin.');if(uid===info.botID)throw new Error('Bot cannot remove itself.');
      if(![...info.admins,...info.members].some(m=>m.id===uid))throw new Error('User is not in this group.');
      await callMessengerApi('removeUserFromGroup',[uid,id]);return{ok:true,removed:uid};
    },
    async sendMessengerReply(threadID,message,options={}){
      if(!api||status!=='connected')throw new Error('Connect the account with a valid AppState first.');
      const id=String(threadID||''),body=typeof message==='string'?message.trim():'';if(!/^\d{1,40}$/.test(id))throw new Error('Invalid thread ID.');if(body.length>2000)throw new Error('Message is limited to 2000 characters.');
      let temp='';const data=typeof options.imageData==='string'?options.imageData:'';
      if(data){const match=data.match(/^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=]+)$/);if(!match)throw new Error('Unsupported image format.');
        const buf=Buffer.from(match[2],'base64');if(!buf.length||buf.length>5*1024*1024)throw new Error('Image must be 5 MB or smaller.');
        const mime=match[1],valid=mime==='image/png'?buf.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):mime==='image/jpeg'?buf[0]===255&&buf[1]===216&&buf[buf.length-1]===255&&buf[buf.length-2]===217:mime==='image/gif'?buf.subarray(0,3).toString()==='GIF':buf.subarray(0,4).toString()==='RIFF'&&buf.subarray(8,12).toString()==='WEBP';if(!valid)throw new Error('Image signature mismatch.');
        const dir=path.join(config.dataDir,'messenger-uploads');await fs.mkdir(dir,{recursive:true,mode:0o700});const extension={ 'image/jpeg':'.jpg','image/png':'.png','image/gif':'.gif','image/webp':'.webp' }[mime];temp=path.join(dir,require('node:crypto').randomUUID()+extension);await fs.writeFile(temp,buf,{mode:0o600,flag:'wx'});
      }
      if(!body&&!temp)throw new Error('Write a message or attach an image.');if(typeof api.sendMessage!=='function')throw new Error('FCA sendMessage is unavailable.');
      const payload=temp?{body,attachment:fs.createReadStream(temp),...(options.silent?{isSilent:true}:{})}:options.silent?{body,isSilent:true}:body;
      try{const result=await callMessengerApi('sendMessage',[payload,id],30000);return{sent:true,silent:!!options.silent,hasImage:!!temp,result:result||null};}finally{if(temp)await fs.unlink(temp).catch(()=>{});}
    },
    async handleMessengerRequest(threadID, accept = true) {
      if (!api || status !== 'connected') throw new Error('Connect the account with a valid AppState first.');
      if (!/^\d{1,40}$/.test(String(threadID))) throw new Error('Invalid thread ID.');
      if (typeof api.handleMessageRequest !== 'function') throw new Error('This FCA version does not expose message-request accept/decline.');
      return new Promise((resolve, reject) => {
        let done = false; const timer = setTimeout(() => finish(new Error('Message-request action timed out.')), 15000);
        function finish(error, value) {
          if (done) return; done = true; clearTimeout(timer);
          error ? reject(new Error(String(error.message || error).slice(0, 220))) : resolve({ ok: true, result: value || null });
        }
        try {
          const result = api.handleMessageRequest(String(threadID), !!accept, finish);
          if (result && typeof result.then === 'function') result.then(value => finish(null, value), finish);
        } catch (error) { finish(error); }
      });
    },
    get api() { return api; },
    async editCommand(name, source) {
      // Normalize dashboard input before validating; mobile keyboards may add whitespace.
      name = typeof name === 'string' ? name.replace(/[\u200B-\u200D\uFEFF]/g, '').trim() : '';
      if (!/^[a-z0-9_-]{1,32}\.js$/i.test(name)) throw new Error('Invalid command filename. Use a name like nm.js (letters, numbers, _ or - only).');
      const vm = require('node:vm');
      new vm.Script(source, { filename: name });
      const target = path.resolve(cmdsDir, name);
      if (path.dirname(target) !== path.resolve(cmdsDir)) throw new Error('Invalid path');
      await fs.mkdir(path.join(config.dataDir, 'backups'), { recursive: true, mode: 0o700 });
      try {
        const old = await fs.readFile(target, 'utf8');
        await atomicWrite(path.join(config.dataDir, 'backups', `${name}.${Date.now()}.bak`), old);
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await atomicWrite(target, source, 0o600);
      const result = runtime.refreshCommands();
      if (result.errors.some(e => e.file === name)) throw new Error('Command failed validation after save');
      return result;
    },
    async deleteCommand(name) {
      name = typeof name === 'string' ? name.trim() : '';
      if (!/^[a-z0-9_-]{1,32}\.js$/i.test(name)) throw new Error('Invalid command filename. Use a name like nm.js (letters, numbers, _ or - only).');
      const target = path.resolve(cmdsDir, name);
      if (path.dirname(target) !== path.resolve(cmdsDir)) throw new Error('Invalid path');
      await fs.unlink(target);
      return runtime.refreshCommands();
    }
  };
  return runtime;
}
module.exports = { createBotRuntime };
