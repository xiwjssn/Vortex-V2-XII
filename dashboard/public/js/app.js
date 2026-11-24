let csrfToken = '';
let currentRole = 'admin';
let ownerID = '';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
async function api(url, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  opts.headers = { ...(opts.headers || {}) };
  if (method !== 'GET') { opts.headers['Content-Type'] = 'application/json'; opts.headers['X-CSRF-Token'] = csrfToken; }
  const r = await fetch(url, opts);
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) { location.href = '/login'; throw Error('Authentication required'); }
  if (!r.ok) throw Error(d.error || 'Request failed');
  return d;
}
function notice(msg, err = false) {
  const n = $('#notice'); n.textContent = msg; n.hidden = false;
  n.className = 'notice ' + (err ? 'danger' : 'success');
  setTimeout(() => n.hidden = true, 4500);
}
function fmt(t) { return t ? new Date(t).toLocaleString() : '—'; }
function duration(ms) {
  let s = Math.max(0, Math.floor((ms || 0) / 1000)), h = Math.floor(s / 3600);
  s %= 3600; const m = Math.floor(s / 60); s %= 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}
function ensureAppStateRefreshPanel() {
  if (currentRole !== 'owner') return;
  const section = $('#appstate');
  if (!section || $('#appstate-refresh-panel')) return;
  const heading = section.querySelector('.section-heading');
  const panel = document.createElement('div');
  panel.id = 'appstate-refresh-panel';
  panel.className = 'panel';
  panel.style.marginBottom = '16px';
  panel.innerHTML = `
    <div class="panel-head"><div><p class="eyebrow">SESSION MAINTENANCE</p><h3>Cookie / AppState refresh</h3></div><span id="appstate-refresh-running" class="muted">Scheduled every 3 hours</span></div>
    <div class="stats-grid">
      <article class="stat-card"><span>Successful refreshes</span><strong id="appstate-refresh-success">0</strong><small>Saved AppState snapshots</small></article>
      <article class="stat-card"><span>Failed refreshes</span><strong id="appstate-refresh-failures">0</strong><small>Attempts that did not complete</small></article>
    </div>
    <div class="detail-row"><span>Last attempt</span><b id="appstate-refresh-last-attempt">—</b></div>
    <div class="detail-row"><span>Last success</span><b id="appstate-refresh-last-success">—</b></div>
    <div class="detail-row"><span>Last failure</span><b id="appstate-refresh-last-failure">—</b></div>
    <div class="detail-row"><span>Last error</span><b id="appstate-refresh-last-error">None</b></div>
    <div class="detail-row"><span>Next refresh in</span><b id="appstate-refresh-countdown">—</b></div>
    <div class="button-row"><button id="refresh-appstate-now" class="primary">Refresh now ↻</button></div>
    <p class="muted">Only refresh statistics are shown here. Cookie values and AppState are never displayed or logged.</p>`;
  if (heading) heading.after(panel); else section.prepend(panel);
  $('#refresh-appstate-now').addEventListener('click', async () => {
    const button = $('#refresh-appstate-now');
    button.disabled = true; button.textContent = 'Refreshing…';
    try {
      const d = await api('/api/appstate/refresh', { method: 'POST', body: '{}' });
      notice('AppState refresh completed and saved.');
      updateAppStateRefresh(d.state);
      await status();
    } catch (e) {
      notice(e.message, true);
      await status().catch(() => {});
    } finally { button.disabled = false; button.textContent = 'Refresh now ↻'; }
  });
}
function ensureSessionHealthPanel() {
  const overview = $('#overview');
  if (!overview || $('#session-health-panel')) return;
  const hero = overview.querySelector('.hero');
  const panel = document.createElement('div');
  panel.id = 'session-health-panel';
  panel.className = 'panel';
  panel.style.marginTop = '16px';
  panel.style.marginBottom = '16px';
  panel.innerHTML = `
    <div class="panel-head"><div><p class="eyebrow">SESSION MONITOR</p><h3 id="session-health-title">Checking session…</h3></div><span id="session-health-badge" class="role-badge">UNKNOWN</span></div>
    <p id="session-health-message" class="muted">Reading the current FCA connection state.</p>
    <div class="button-row" id="session-health-actions" hidden><button id="session-health-open-appstate" class="primary">Open AppState settings</button></div>`;
  if (hero) hero.after(panel); else overview.prepend(panel);
  $('#session-health-open-appstate')?.addEventListener('click', () => {
    const link = $('#nav a[href="#appstate"]');
    if (currentRole !== 'owner' || !link) return;
    link.click();
  });
}
function updateSessionHealth(s) {
  ensureSessionHealthPanel();
  const title = $('#session-health-title');
  const badge = $('#session-health-badge');
  const message = $('#session-health-message');
  const actions = $('#session-health-actions');
  if (!title || !badge || !message) return;
  const needsAttention = !!s.requiresSessionUpdate || s.sessionHealth === 'needs-attention' || s.status === 'needs-attention';
  const connected = s.status === 'connected';
  title.textContent = needsAttention ? 'Session needs attention' : connected ? 'Bot session connected' : s.status === 'connecting' ? 'Connection in progress' : 'Bot session disconnected';
  badge.textContent = needsAttention ? 'ACTION NEEDED' : connected ? 'CONNECTED' : String(s.sessionHealth || s.status || 'UNKNOWN').toUpperCase();
  badge.classList.toggle('owner', connected);
  badge.style.background = needsAttention ? '#3a2027' : connected ? '#14332d' : '#292316';
  badge.style.color = needsAttention ? '#ff9bab' : connected ? '#78efbd' : '#e6c77e';
  message.textContent = s.sessionMessage || (connected
    ? 'The bot connection is active. Facebook controls whether the green online indicator appears.'
    : 'The bot is not currently connected. Check the connection panel and recent logs.');
  if (actions) actions.hidden = currentRole !== 'owner' || !needsAttention;
}
let appStateRefreshSnapshot = null;
function updateAppStateRefresh(s) {
  if (currentRole !== 'owner' || !s) return;
  appStateRefreshSnapshot = s;
  ensureAppStateRefreshPanel();
  $('#appstate-refresh-success').textContent = String(s.successCount || 0);
  $('#appstate-refresh-failures').textContent = String(s.failureCount || 0);
  $('#appstate-refresh-last-attempt').textContent = fmt(s.lastAttemptAt);
  $('#appstate-refresh-last-success').textContent = fmt(s.lastSuccessAt);
  $('#appstate-refresh-last-failure').textContent = fmt(s.lastFailureAt);
  $('#appstate-refresh-last-error').textContent = s.lastError || 'None';
  $('#appstate-refresh-running').textContent = s.refreshing ? 'Refresh in progress…' : 'Scheduled every 3 hours';
  updateAppStateCountdown();
}
function updateAppStateCountdown() {
  const target = appStateRefreshSnapshot?.nextRefreshAt;
  const node = $('#appstate-refresh-countdown');
  if (node) node.textContent = target ? duration(Date.parse(target) - Date.now()) : '—';
}
async function status() {
  const s = await api('/api/status');
  $('#bot-status').textContent = s.status;
  $('#bot-detail').textContent = s.appStateConfigured ? 'AppState configured' : 'Waiting for session';
  $('#fca-status').textContent = s.fcaStatus;
  $('#mqtt-status').textContent = 'MQTT: ' + (s.mqttStatus || 'unknown');
  $('#command-count').textContent = s.commands;
  $('#uptime').textContent = duration(s.uptimeMs);
  $('#reconnects').textContent = s.reconnectAttempts;
  $('#top-state').textContent = s.status;
  $('#last-connection').textContent = fmt(s.lastConnection);
  $('#last-disconnect').textContent = fmt(s.lastDisconnect);
  $('#last-error').textContent = s.lastError || 'None';
  $('#connection-status').textContent = s.status;
  $('#connection-retries').textContent = s.reconnectAttempts;
  $('#connection-last').textContent = fmt(s.lastConnection);
  $('#bot-details').innerHTML = [['Name', s.bot], ['Prefix', s.prefix], ['Status', s.status], ['Version', s.version],
    ['Uptime', duration(s.uptimeMs)], ['Loaded commands', s.commands], ['Last error', s.lastError || 'None'],
    ['Last reconnect', fmt(s.lastDisconnect)]].map(([k, v]) => `<div class="detail-row"><span>${esc(k)}</span><b>${esc(String(v))}</b></div>`).join('');
  $('#footer-version').textContent = 'v' + s.version;
  updateSessionHealth(s);
  updateAppStateRefresh(s.appStateRefresh);
  const outbound = s.outboundProtection || {};
  const outboundNode = $('#outbound-protection-status');
  if (outboundNode) {
    if (outbound.paused) {
      const until = outbound.pausedUntil ? fmt(new Date(outbound.pausedUntil).toISOString()) : 'until a fresh AppState is saved';
      outboundNode.textContent = 'PAUSED · ' + (outbound.pauseReason || 'safety stop') + ' · ' + until +
        ' · failures in window: ' + (outbound.failuresLastWindow || 0);
    } else {
      outboundNode.textContent = 'ACTIVE · sends in last minute: ' + (outbound.sendsLastMinute || 0) +
        ' · failures in window: ' + (outbound.failuresLastWindow || 0) +
        ' · automatic pause after ' + (outbound.maxConsecutiveFailures || 3) + ' consecutive send failures';
    }
  }
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function commands() {
  const d = await api('/api/commands');
  $('#commands-table').innerHTML = d.commands.map(c => {
    const actions = currentRole === 'owner'
      ? '<button class="mini" data-edit="' + esc(c.name) + '">Edit</button> <button class="mini danger-text" data-delete="' + esc(c.file) + '">Delete</button>'
      : 'Read only';
    return '<tr><td>' + esc(c.name) + '</td><td>' + esc(c.aliases.join(', ')) + '</td><td>' + esc(c.description) + '</td><td>' + (c.adminOnly ? 'Yes' : 'No') + '</td><td>' + esc(c.file) + '</td><td>' + actions + '</td></tr>';
  }).join('');
}
async function admins() {
  const d = await api('/api/admins');
  ownerID = d.ownerID || '';
  const owners = d.owners || (ownerID ? [ownerID] : []);
  $('#owner-count').textContent = owners.length + ' / 3';
  $('#admin-count').textContent = d.admins.length + ' / 20';
  $('#owner-list').innerHTML = owners.map(id => '<span class="pill">' + esc(id) + (owners.length > 1 ? ' <button data-remove-owner="' + esc(id) + '" aria-label="Remove owner ' + esc(id) + '">×</button>' : '') + '</span>').join('') || '<p class="muted">No Owners configured.</p>';
  $('#admin-list').innerHTML = d.admins.map(id => '<span class="pill">' + esc(id) + ' <button data-remove-admin="' + esc(id) + '" aria-label="Remove admin ' + esc(id) + '">×</button></span>').join('') || '<p class="muted">No regular Admin IDs configured.</p>';
  $('#owner-input-id').disabled = owners.length >= 3;
  $('#admin-id').disabled = d.admins.length >= 20;
}
async function settings() {
  const s = await api('/api/settings'); $('#bot-name').value = s.botName; $('#prefix').value = s.prefix; $('#language').value = s.language || 'ar';
}
async function logs() {
  const q = encodeURIComponent($('#log-search').value), t = encodeURIComponent($('#log-type').value);
  const d = await api(`/api/logs?q=${q}&type=${t}`);
  $('#logs-list').innerHTML = d.logs.slice().reverse().map(l => `<div class="log-row"><time>${esc(fmt(l.time))}</time><b class="log-${esc(l.type.toLowerCase())}">${esc(l.type)}</b><span>${esc(l.message)}</span></div>`).join('') || '<p class="muted">No logs captured in this process.</p>';
}
let messengerFolder='inbox',messengerThread=null,messengerThreads=[],messengerSilent=false,messengerImageFile=null;
function messengerQuery(path){return path;}
function messengerTime(value){if(!value)return '';const n=Number(value),d=new Date(n<1e12?n*1000:n);return Number.isNaN(d.getTime())?'':d.toLocaleString();}
async function refreshMessengerAccess(){const nav=$('#messenger-nav');if(!nav)return;try{const a=await api('/api/messenger/status');nav.hidden=!a.configured;}catch{nav.hidden=true;}}
async function loadMessenger(){try{const st=await api('/api/messenger/status');$('#messenger-connection').textContent=st.connected?'● Primary account connected':st.configured?'○ Account offline':'🔒 No linked session';$('#messenger-help').textContent=st.connected?'Select a chat; group controls depend on the bot admin role.':'Connect the primary account from AppState settings first.';if(!st.configured||!st.connected){$('#messenger-threads').innerHTML='<p class="muted">Messenger is locked until a session is connected.</p>';$('#messenger-messages').innerHTML='<p class="muted">No active session.</p>';$('#messenger-reply-form').hidden=true;return;}const d=await api('/api/messenger/threads?folder='+encodeURIComponent(messengerFolder));messengerThreads=d.threads||[];$('#messenger-list-label').textContent=messengerFolder.charAt(0).toUpperCase()+messengerFolder.slice(1);renderMessengerThreads();}catch(e){$('#messenger-connection').textContent='Messenger unavailable';$('#messenger-threads').innerHTML='<p class="muted">'+esc(e.message)+'</p>';}}
function renderMessengerThreads(){const q=($('#messenger-search').value||'').toLowerCase(),v=messengerThreads.filter(t=>(t.name+' '+t.snippet).toLowerCase().includes(q));$('#messenger-inbox-count').textContent=messengerFolder==='inbox'?String(messengerThreads.length):'—';$('#messenger-threads').innerHTML=v.map(t=>'<button class="messenger-thread '+(messengerThread&&messengerThread.threadID===t.threadID?'active':'')+'" data-messenger-thread="'+esc(t.threadID)+'"><span class="messenger-avatar">'+esc((t.name||'?').slice(0,1).toUpperCase())+'</span><span class="messenger-thread-copy"><b>'+esc(t.name||'Conversation')+'</b><small>'+esc(t.snippet||'No preview')+'</small><small>'+esc(messengerTime(t.timestamp))+'</small></span>'+(t.unreadCount?'<i>'+esc(String(t.unreadCount))+'</i>':'')+'</button>').join('')||'<p class="muted">No conversations found.</p>';}
function renderMessengerMessages(messages){return(messages||[]).map(m=>{const images=(m.attachments||[]).filter(x=>x.imageUrl).map(x=>'<a class="message-image-link" href="'+esc(x.imageUrl)+'" target="_blank" rel="noopener"><img class="message-image" src="'+esc(x.imageUrl)+'" alt="Image attachment" loading="lazy"></a>').join('');return'<div class="messenger-bubble '+(m.senderID===ownerID?'outgoing':'')+'">'+(m.body?'<p>'+esc(m.body)+'</p>':'')+images+'<small>'+esc(messengerTime(m.timestamp))+'</small></div>';}).join('')||'<p class="muted">No messages returned.</p>';}
async function openMessengerThread(id){const t=messengerThreads.find(x=>x.threadID===id);if(!t)return;messengerThread=t;$('#messenger-chat-title').textContent=t.name||'Conversation';$('#messenger-chat-subtitle').textContent=(t.isGroup?'Group chat':'Conversation')+' · '+id;$('#messenger-chat-avatar').textContent=(t.name||'?').slice(0,1).toUpperCase();$('#messenger-request-actions').hidden=messengerFolder!=='requests'||currentRole!=='owner';$('#messenger-reply-form').hidden=currentRole!=='owner';$('#messenger-members-open').hidden=!t.isGroup;$('#messenger-members-panel').hidden=true;$('#messenger-messages').innerHTML='<p class="muted">Loading…</p>';renderMessengerThreads();try{const d=await api('/api/messenger/threads/'+encodeURIComponent(id)+'/messages');$('#messenger-messages').innerHTML=renderMessengerMessages(d.messages);$('#messenger-messages').scrollTop=$('#messenger-messages').scrollHeight;}catch(e){$('#messenger-messages').innerHTML='<p class="muted">'+esc(e.message)+'</p>';}}
async function messengerRequestAction(action){if(!messengerThread)return;try{await api('/api/messenger/requests/'+encodeURIComponent(messengerThread.threadID),{method:'POST',body:JSON.stringify({action})});notice(action==='accept'?'Request accepted.':'Request declined.');messengerThread=null;await loadMessenger();}catch(e){notice(e.message,true);}}
function resetMessengerImage(){messengerImageFile=null;$('#messenger-image').value='';$('#messenger-image-name').textContent='';const preview=$('#messenger-image-preview-img');if(preview.src.startsWith('blob:'))URL.revokeObjectURL(preview.src);preview.removeAttribute('src');$('#messenger-image-preview').hidden=true;}
function bindMessenger(){
 $('#messenger-refresh')?.addEventListener('click',loadMessenger);$('#messenger-search')?.addEventListener('input',renderMessengerThreads);
 $$('.messenger-folder').forEach(b=>b.addEventListener('click',()=>{$$('.messenger-folder').forEach(x=>x.classList.toggle('active',x===b));messengerFolder=b.dataset.folder;messengerThread=null;$('#messenger-reply-form').hidden=true;loadMessenger();}));
 $('#messenger-threads')?.addEventListener('click',e=>{const x=e.target.closest('[data-messenger-thread]');if(x)openMessengerThread(x.dataset.messengerThread);});
 $('#messenger-accept')?.addEventListener('click',()=>messengerRequestAction('accept'));$('#messenger-decline')?.addEventListener('click',()=>messengerRequestAction('decline'));
 $('#messenger-attach')?.addEventListener('click',()=>{const picker=$('#messenger-image');if(picker.showPicker){try{picker.showPicker();return;}catch{}}picker.click();});$('#messenger-image-clear')?.addEventListener('click',resetMessengerImage);
 $('#messenger-image')?.addEventListener('change',e=>{const f=e.target.files?.[0];if(!f){resetMessengerImage();return;}if(!/^image\/(jpeg|png|gif|webp)$/.test(f.type)||f.size>5*1024*1024){notice('اختَر صورة JPEG أو PNG أو GIF أو WebP بحجم 5 MB أو أقل.',true);resetMessengerImage();return;}messengerImageFile=f;$('#messenger-image-name').textContent=f.name;$('#messenger-image-preview-img').src=URL.createObjectURL(f);$('#messenger-image-preview').hidden=false;});
 $('#messenger-silent')?.addEventListener('click',()=>{messengerSilent=!messengerSilent;$('#messenger-silent').classList.toggle('active',messengerSilent);$('#messenger-silent').setAttribute('aria-pressed',String(messengerSilent));});
 $('#messenger-reply')?.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('#messenger-reply-form').requestSubmit();}});
 $('#messenger-reply-form')?.addEventListener('submit',async e=>{e.preventDefault();if(!messengerThread)return;const btn=e.currentTarget.querySelector('.messenger-send'),field=$('#messenger-reply');let message=field.value.trim(),silent=messengerSilent;if(/^\/silent(?:\s|$)/i.test(message)){silent=true;message=message.replace(/^\/silent\s*/i,'');}if(!message&&!messengerImageFile){notice('Write a message or attach an image.',true);return;}btn.disabled=true;btn.textContent='Sending…';try{let imageData='';if(messengerImageFile)imageData=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||''));reader.onerror=()=>reject(new Error('Image read failed'));reader.readAsDataURL(messengerImageFile);});await api('/api/messenger/threads/'+encodeURIComponent(messengerThread.threadID)+'/messages',{method:'POST',body:JSON.stringify({message,silent,imageData})});field.value='';resetMessengerImage();messengerSilent=false;$('#messenger-silent').classList.remove('active');$('#messenger-silent').setAttribute('aria-pressed','false');notice('Message sent.');await openMessengerThread(messengerThread.threadID);}catch(x){notice(x.message,true);}finally{btn.disabled=false;btn.innerHTML='Send <span>↗</span>'; }});
 $('#messenger-members-open')?.addEventListener('click',loadMessengerMembers);$('#messenger-members-close')?.addEventListener('click',()=>$('#messenger-members-panel').hidden=true);
 $('#messenger-add-member-form')?.addEventListener('submit',async e=>{e.preventDefault();if(!messengerThread)return;const field=$('#messenger-add-member-id');try{await api('/api/messenger/threads/'+encodeURIComponent(messengerThread.threadID)+'/members',{method:'POST',body:JSON.stringify({userID:field.value.trim()})});notice('Member added.');field.value='';await loadMessengerMembers();}catch(x){notice(x.message,true);}});
 $('#messenger-admin-members')?.addEventListener('click',removeMessengerMember);$('#messenger-normal-members')?.addEventListener('click',removeMessengerMember);
}
async function loadMessengerMembers(){if(!messengerThread)return;$('#messenger-members-panel').hidden=false;$('#messenger-members-status').textContent='Loading group…';try{const d=await api('/api/messenger/threads/'+encodeURIComponent(messengerThread.threadID)+'/info');$('#messenger-members-status').textContent=d.isBotAdmin?'Bot is group admin · management enabled':'Bot is not group admin · view only';$('#messenger-add-member-form').hidden=!d.isBotAdmin||currentRole!=='owner';$('#messenger-admin-count').textContent=d.admins.length;$('#messenger-normal-count').textContent=d.members.length;const render=(list,isAdminList)=>list.map(m=>'<div class="member-row"><span class="member-avatar">'+esc((m.name||m.id||'?').slice(0,1).toUpperCase())+'</span><span class="member-name"><b>'+esc(m.name||'Member')+'</b>'+(isAdminList?'<span class="member-admin-badge">💠 مشرف</span>':'')+'<small>'+esc(m.id)+'</small></span>'+(d.isBotAdmin&&currentRole==='owner'&&m.id!==d.botID?'<button class="member-remove" data-remove-member="'+esc(m.id)+'" aria-label="Kick '+esc(m.name||m.id)+'">Kick</button>':'')+'</div>').join('')||'<p class="muted">No members.</p>';$('#messenger-admin-members').innerHTML=render(d.admins,true);$('#messenger-normal-members').innerHTML=render(d.members,false);}catch(e){$('#messenger-members-status').textContent=e.message;}}
async function removeMessengerMember(e){const btn=e.target.closest('[data-remove-member]');if(!btn||!messengerThread)return;btn.disabled=true;btn.textContent='…';try{await api('/api/messenger/threads/'+encodeURIComponent(messengerThread.threadID)+'/members/'+encodeURIComponent(btn.dataset.removeMember),{method:'DELETE'});notice('تم طرد العضو من المجموعة فوراً.');await loadMessengerMembers();}catch(x){notice(x.message,true);btn.disabled=false;btn.textContent='Kick';}}
function applyRole(role) {
  currentRole = role === 'owner' ? 'owner' : 'admin';
  document.body.dataset.role = currentRole;
  const badge = $('#role-label');
  if (badge) {
    badge.textContent = currentRole === 'owner' ? 'OWNER · FULL ACCESS' : 'ADMIN · READ ONLY';
    badge.classList.toggle('owner', currentRole === 'owner');
  }
  $$('[data-owner-only]').forEach(node => { node.hidden = currentRole !== 'owner'; });
  if (currentRole !== 'owner') {
    const active = $('.page.active');
    if (active && active.hasAttribute('data-owner-only')) {
      $('.page').forEach(p => p.classList.toggle('active', p.id === 'overview'));
      $('#nav a').forEach(n => n.classList.toggle('active', n.getAttribute('href') === '#overview'));
      $('#page-title').textContent = 'Overview';
    }
  }
}
async function refreshAll() {
  try {
    const jobs = [status(), commands(), logs()];
        if (currentRole === 'owner') jobs.push(admins(), settings());
    await Promise.all(jobs);
  } catch (e) { if (!String(e.message).includes('Authentication')) notice(e.message, true); }
}
async function action(name) {
  try {
    if (name === 'refresh') { await refreshAll(); return notice('Dashboard refreshed.'); }
    const d = await api('/api/connection/' + name, { method: 'POST', body: '{}' });
    notice('Connection status: ' + (d.status || 'updated')); await status();
  } catch (e) { notice(e.message, true); }
}
document.addEventListener('click', async e => {
  const a = e.target.closest('[data-action]'); if (a) action(a.dataset.action);
  const edit = e.target.closest('[data-edit]');
  if (edit) {
    try { $('#command-file').value = edit.dataset.edit + '.js'; $('#command-source').value = (await api('/api/commands/' + encodeURIComponent(edit.dataset.edit) + '/source')).source; $('#editor-wrap').hidden = false; }
    catch (x) { notice(x.message, true); }
  }
  const del = e.target.closest('[data-delete]');
  if (del && confirm('Delete command ' + del.dataset.delete + '?')) {
    try { await api('/api/commands/' + encodeURIComponent(del.dataset.delete), { method: 'DELETE' }); await commands(); notice('Command deleted.'); }
    catch (x) { notice(x.message, true); }
  }
  const ownerRm = e.target.closest('[data-remove-owner]');
  if (ownerRm && confirm('Remove this Owner? At least one Owner must remain.')) {
    try { await api('/api/owners/' + encodeURIComponent(ownerRm.dataset.removeOwner), { method: 'DELETE' }); await admins(); notice('Owner removed and saved.'); }
    catch (x) { notice(x.message, true); }
  }
  const rm = e.target.closest('[data-remove-admin]');
  if (rm && confirm('Remove this admin?')) {
    try { await api('/api/admins/' + encodeURIComponent(rm.dataset.removeAdmin), { method: 'DELETE' }); await admins(); notice('Admin removed.'); }
    catch (x) { notice(x.message, true); }
  }
});
$('#logout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); } finally { location.href = '/login'; }
});
$('#menu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
document.addEventListener('click', e => {
  const a = e.target.closest('#nav a[href^="#"]');
  if (!a) return;
  e.preventDefault();
  const id = a.getAttribute('href').slice(1);
  const page = document.getElementById(id);
  if (!page) return;
  if (a.id === 'messenger-nav') {
    api(messengerQuery('/api/messenger/status')).then(state => {
      if (!state.configured || !state.connected) return notice('Link and connect the account first to unlock Messenger.', true);
      $$('.page').forEach(p => p.classList.toggle('active', p.id === id));
      $$('#nav a').forEach(n => n.classList.toggle('active', n === a));
      $('#page-title').textContent = a.textContent.trim().replace(/^[^a-zA-Z]+/, '');
      $('#sidebar').classList.remove('open');
    }).catch(error => notice(error.message, true));
    return;
  }
  $$('.page').forEach(p => p.classList.toggle('active', p.id === id));
  $$('#nav a').forEach(n => n.classList.toggle('active', n === a));
  $('#page-title').textContent = a.textContent.trim().replace(/^[^a-zA-Z]+/, '');
  $('#sidebar').classList.remove('open');
});
ensureAppStateRefreshPanel();
$('#validate-appstate').addEventListener('click', async () => {
  try {
    const appState = JSON.parse($('#appstate-input').value);
    await api('/api/appstate/validate', { method: 'POST', body: JSON.stringify({ appState }) });
    $('#appstate-result').textContent = 'Valid AppState format. Content was not logged.';
    notice('AppState format is valid.');
  } catch (e) { $('#appstate-result').textContent = e.message; notice(e.message, true); }
});
$('#save-appstate').addEventListener('click', () => saveAppState(false));
$('#connect-appstate').addEventListener('click', () => saveAppState(true));
$('#remove-appstate-session').addEventListener('click', async () => {
  const confirmed = confirm(
    'Remove the saved AppState session? The bot will disconnect and delete its locally saved session and refresh statistics. Commands, dashboard settings, and admin lists will remain.'
  );
  if (!confirmed) return;
  const button = $('#remove-appstate-session');
  button.disabled = true;
  button.textContent = 'Removing…';
  try {
    await api('/api/appstate/session', { method: 'DELETE' });
    $('#appstate-input').value = '';
    $('#appstate-result').textContent = 'Session removed. Paste a new AppState to connect again.';
    notice('Session removed. The bot is offline until a new AppState is saved.');
    await status();
  } catch (e) {
    notice(e.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Remove session';
  }
});
async function saveAppState(connect) {
  try {
    const appState = JSON.parse($('#appstate-input').value);
    const d = await api('/api/appstate/' + (connect ? 'connect' : 'save'), { method: 'POST', body: JSON.stringify({ appState }) });
    $('#appstate-input').value = '';
    $('#appstate-result').textContent = connect ? 'Connection attempt completed.' : 'AppState saved securely.';
    notice(connect ? 'Connection attempt completed.' : 'AppState saved securely.');
    await status();
  } catch (e) { notice(e.message, true); }
}
$('#refresh-commands').addEventListener('click', async () => {
  try { await api('/api/commands/refresh', { method: 'POST', body: '{}' }); await commands(); notice('Commands refreshed.'); }
  catch (e) { notice(e.message, true); }
});
$('#new-command').addEventListener('click', () => {
  $('#command-file').value = '';
  $('#command-source').value = "module.exports = { name: 'example', aliases: [], description: 'Example command', async execute(api, event) { return api.sendMessage('VORTEX', event.threadID, event.messageID); } };";
  $('#editor-wrap').hidden = false;
});
$('#cancel-editor').addEventListener('click', () => $('#editor-wrap').hidden = true);
$('#save-command').addEventListener('click', async () => {
  try {
    const file = $('#command-file').value.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (!/^[a-z0-9_-]{1,32}\.js$/i.test(file)) throw Error('اسم الملف غير صالح. اكتب nm.js فقط، باستخدام حروف إنجليزية أو أرقام أو _ أو - قبل .js.');
    $('#command-file').value = file;
    await api('/api/commands/' + encodeURIComponent(file) + '/save', { method: 'POST', body: JSON.stringify({ source: $('#command-source').value }) });
    $('#editor-wrap').hidden = true; await commands(); notice('Command validated and saved.');
  } catch (e) { notice(e.message, true); }
});
$('#owner-form').addEventListener('submit', async e => {
  e.preventDefault();
  try { await api('/api/owners', { method: 'POST', body: JSON.stringify({ id: $('#owner-input-id').value.trim() }) }); $('#owner-input-id').value = ''; await admins(); notice('Owner saved.'); }
  catch (x) { notice(x.message, true); }
});
$('#admin-form').addEventListener('submit', async e => {
  e.preventDefault();
  try { await api('/api/admins', { method: 'POST', body: JSON.stringify({ id: $('#admin-id').value }) }); $('#admin-id').value = ''; await admins(); notice('Admin saved.'); }
  catch (x) { notice(x.message, true); }
});
$('#settings-form').addEventListener('submit', async e => {
  e.preventDefault();
  try { await api('/api/settings', { method: 'PUT', body: JSON.stringify({ botName: $('#bot-name').value, prefix: $('#prefix').value, language: $('#language').value }) }); notice('Settings saved.'); await status(); }
  catch (x) { notice(x.message, true); }
});
$('#log-search').addEventListener('input', () => logs().catch(() => {}));
$('#log-type').addEventListener('change', () => logs().catch(() => {}));
$('#clear-logs').addEventListener('click', async () => {
  try { await api('/api/logs', { method: 'DELETE' }); await logs(); notice('Logs cleared.'); }
  catch (e) { notice(e.message, true); }
});
(async () => {
  try {
    const s = await fetch('/api/session');
    if (!s.ok) { location.href = '/login'; return; }
    const d = await s.json(); csrfToken = d.csrfToken; currentRole = d.role || 'admin'; ownerID = d.ownerID || ''; sessionStorage.setItem('vortex-csrf', csrfToken);
    applyRole(currentRole);
    bindMessenger();
    await refreshMessengerAccess();
    await refreshAll();
    setInterval(() => { status().catch(() => {}); refreshMessengerAccess().catch(() => {}); }, 5000);
    setInterval(() => logs().catch(() => {}), 7000);
    setInterval(updateAppStateCountdown, 1000);
  } catch { location.href = '/login'; }
})();
