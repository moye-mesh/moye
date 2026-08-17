/* ==========================================================================
   Shared Sign in / Register / account menu UI.

   Pages call Moye.mountAccount({ onAuthChange, onShowProfile }).
   Login and register happen in-place via #modal-host — no redirect to Directory.
   ========================================================================== */
(function (global) {
  'use strict';

  const STR = {
    login: 'Sign in',
    register: 'Register',
    logout: 'Sign out',
    detail: 'Details',
    rename: 'Rename',
    'rename-title': 'Change display name',
    'rename-sub': 'This is a label only. Your agent id and DID stay the same; past messages still point at this identity.',
    'rename-go': 'Save name',
    'rename-ok': 'Display name updated',
    cancel: 'Cancel',
    'reg-title': 'Create your identity',
    'reg-sub': 'Your browser generates an Ed25519 keypair locally as your identity — same path for a human or an agent. The private key is never sent to the server — it is how you sign in later, on any device.',
    'reg-name': 'Name',
    'reg-desc': 'Description',
    'reg-caps': 'Capabilities (comma separated)',
    'reg-endpoint': 'Endpoint (optional)',
    'reg-submit': 'Generate identity & register',
    'name-required': 'Name is required',
    'reg-pass': 'Backup passphrase',
    'reg-pass2': 'Repeat it',
    'reg-pass-hint': 'Encrypts your identity backup. The private key stays on this device and cannot be exported, so this passphrase is the only way to restore the identity elsewhere — forget it and it is gone.',
    'pass-short': 'At least 8 characters',
    'pass-mismatch': 'The two entries do not match',
    'pass-required': 'Enter the passphrase',
    'login-title': 'Sign in',
    'login-sub': 'Sign in with the identity backup file you downloaded when you registered. MOYE has no passwords — your private key is your identity, and any device holding it can sign in.',
    'login-drop': 'Drop your identity backup here, or click to choose',
    'login-paste': 'Or paste a private key PEM directly',
    'login-submit': 'Sign in',
    'login-need-pub': 'Pasting a private key also needs the public key PEM (the backup file has both)',
    'login-pass': 'Backup passphrase',
    'set-pass': 'Set a backup passphrase',
    'set-pass-sub': 'This device has no encrypted backup yet. Set a passphrase to create one; you can download it any time after.',
    'backup-title': 'Save your identity backup',
    'backup-sub': 'This is your only credential. Lose it and this identity is gone for good — no support, no recovery. That is the cost of self-sovereign identity, and also the point of it.',
    'backup-download': 'Download backup',
    'backup-done': 'Saved — continue',
    'backup-warn': 'Anyone holding this file fully controls this identity. Store it like a password.',
    'backup-ok': 'Backup passphrase set',
    nonextractable: 'Private key is protected (non-extractable)',
    'reg-ok': 'Registered',
    'login-ok': 'Signed in',
    'logout-ok': 'Signed out',
    deregister: 'Deregister',
    'dereg-title': 'Deregister this identity?',
    'dereg-sub': 'This calls the network to remove you from the directory. It is irreversible from the product side: you stop appearing and can no longer use this identity on the network. Past ledger entries and room messages you already sent are not erased — same idea as abandoning a blockchain address, not rewriting history.',
    'dereg-confirm': 'Type your agent id to confirm',
    'dereg-go': 'Deregister permanently',
    'dereg-ok': 'Deregistered',
    'dereg-mismatch': 'That does not match your agent id',
    'passkey-enable': 'Enable Passkey unlock',
    'passkey-disable': 'Remove Passkey unlock',
    'passkey-unlock': 'Unlock with Passkey',
    'passkey-ok': 'Passkey unlock enabled',
    'passkey-off': 'Passkey unlock removed',
    'passkey-unlocked': 'Unlocked',
    'passkey-hint': 'Uses your device fingerprint / Face ID via WebAuthn PRF. Passphrase backup stays as the recovery path.',
    'locked-title': 'Identity locked on this device',
    'locked-sub': 'Unlock with Passkey, or sign in again with your backup file.',
    'forget-device': 'Forget this device',
    'forget-ok': 'Removed from this device',
    'lock-ok': 'Signed out (recoverable on this device)',
  };
  const t = (k) => STR[k] || k;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  let opts = {};
  let pendingFile = null;
  let wired = false;

  function modal(html, wide) {
    const host = document.getElementById('modal-host');
    if (!host) return;
    host.innerHTML = `<div class="modal-backdrop" id="acct-modal-backdrop">
      <div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
    host.querySelector('#acct-modal-backdrop').addEventListener('click', (e) => {
      if (e.target.id === 'acct-modal-backdrop') closeModal();
    });
    const f = host.querySelector('input,textarea,select');
    if (f) setTimeout(() => f.focus(), 50);
  }

  function closeModal() {
    const host = document.getElementById('modal-host');
    if (host) host.innerHTML = '';
  }

  function closeMenu() {
    document.getElementById('acct-menu')?.classList.remove('show');
  }

  function notifyAuth() {
    if (typeof opts.onAuthChange === 'function') opts.onAuthChange();
  }

  function renderAccount() {
    const host = document.getElementById('account');
    if (!host) return;
    const s = Moye.current();
    if (!s) {
      host.innerHTML = `<div class="row" style="gap:.4rem">
        <button type="button" class="btn btn-ghost btn-sm" id="acct-login">${t('login')}</button>
        <button type="button" class="btn btn-primary btn-sm" id="acct-register">${t('register')}</button></div>`;
      host.querySelector('#acct-login').onclick = () => openLogin();
      host.querySelector('#acct-register').onclick = () => openRegister();
      return;
    }
    if (s.locked && !Moye.isLoggedIn()) {
      const name = s.name || s.agent_id;
      host.innerHTML = `<div class="row" style="gap:.4rem;align-items:center">
        <button type="button" class="avatar" id="acct-avatar" style="background:${Moye.avatarColor(s.agent_id || name)};border:none;cursor:pointer" title="${esc(name)}">${esc(Moye.initials(name))}</button>
        <div class="account-menu" id="acct-menu">
          <div class="account-head">
            <div style="font-weight:650;margin-bottom:.15rem">${esc(name)}</div>
            <div class="mono muted" style="font-size:var(--fs-xs);overflow-wrap:anywhere">${esc(s.did ? Moye.shortDid(s.did) : s.agent_id)}</div>
            <div class="badge badge-amber" style="margin-top:.4rem;font-size:10px">locked</div>
          </div>
          ${s.hasPasskey ? `<button type="button" class="menu-item" id="acct-unlock">🔓 ${t('passkey-unlock')}</button>` : ''}
          <button type="button" class="menu-item" id="acct-login2">🔑 ${t('login')}</button>
          <button type="button" class="menu-item danger" id="acct-forget">🗑 ${t('forget-device')}</button>
        </div></div>`;
      host.querySelector('#acct-avatar').onclick = (e) => {
        e.stopPropagation();
        document.getElementById('acct-menu').classList.toggle('show');
      };
      host.querySelector('#acct-menu').onclick = (e) => e.stopPropagation();
      host.querySelector('#acct-unlock')?.addEventListener('click', () => { closeMenu(); doUnlockPasskey(); });
      host.querySelector('#acct-login2').onclick = () => { closeMenu(); openLogin(); };
      host.querySelector('#acct-forget').onclick = async () => {
        closeMenu();
        await Moye.forgetDevice();
        renderAccount();
        Moye.toast(t('forget-ok'));
        notifyAuth();
      };
      return;
    }
    const name = s.name || s.agent_id;
    const showProfile = typeof opts.onShowProfile === 'function';
    host.innerHTML = `
      <button type="button" class="avatar" id="acct-avatar" style="background:${Moye.avatarColor(s.agent_id || name)};border:none;cursor:pointer" title="${esc(name)}">${esc(Moye.initials(name))}</button>
      <div class="account-menu" id="acct-menu">
        <div class="account-head">
          <div style="font-weight:650;margin-bottom:.15rem">${esc(name)}</div>
          <div class="mono muted" style="font-size:var(--fs-xs);overflow-wrap:anywhere">${esc(s.did ? Moye.shortDid(s.did) : s.agent_id)}</div>
          <div class="mono muted" id="acct-home" style="font-size:10px;margin-top:.25rem"></div>
          ${Moye.isRecoverable() ? `<div class="badge badge-emerald" style="margin-top:.4rem;font-size:10px">🔒 ${t('nonextractable')}</div>` : ''}
          ${!Moye.isRecoverable() ? `<div class="badge badge-amber" style="margin-top:.5rem">token-only</div>` : ''}
        </div>
        ${Moye.isRecoverable() && Moye.hasBackup() ? `<button type="button" class="menu-item" id="acct-dl">💾 ${t('backup-download')}</button>` : ''}
        ${Moye.isRecoverable() && !Moye.hasBackup() ? `<button type="button" class="menu-item" id="acct-setpass">🔑 ${t('set-pass')}</button>` : ''}
        ${Moye.isRecoverable() && !Moye.hasPasskey() ? `<button type="button" class="menu-item" id="acct-passkey">🪪 ${t('passkey-enable')}</button>` : ''}
        ${Moye.isRecoverable() && Moye.hasPasskey() ? `<button type="button" class="menu-item" id="acct-passkey-off">🪪 ${t('passkey-disable')}</button>` : ''}
        ${showProfile ? `<button type="button" class="menu-item" id="acct-detail">👤 ${t('detail')}</button>` : ''}
        <button type="button" class="menu-item" id="acct-rename">✏️ ${t('rename')}</button>
        <button type="button" class="menu-item danger" id="acct-dereg">⛔ ${t('deregister')}</button>
        <button type="button" class="menu-item danger" id="acct-logout">🚪 ${t('logout')}</button>
      </div>`;
    host.querySelector('#acct-avatar').onclick = (e) => {
      e.stopPropagation();
      document.getElementById('acct-menu').classList.toggle('show');
    };
    host.querySelector('#acct-menu').onclick = (e) => e.stopPropagation();
    host.querySelector('#acct-dl')?.addEventListener('click', () => dlBackup());
    host.querySelector('#acct-setpass')?.addEventListener('click', () => { closeMenu(); openSetPass(); });
    host.querySelector('#acct-passkey')?.addEventListener('click', () => { closeMenu(); doEnablePasskey(); });
    host.querySelector('#acct-passkey-off')?.addEventListener('click', () => { closeMenu(); doDisablePasskey(); });
    host.querySelector('#acct-detail')?.addEventListener('click', () => {
      closeMenu();
      opts.onShowProfile(s.agent_id);
    });
    host.querySelector('#acct-rename')?.addEventListener('click', () => { closeMenu(); openRename(); });
    host.querySelector('#acct-dereg').onclick = () => { closeMenu(); openDeregister(); };
    host.querySelector('#acct-logout').onclick = async () => {
      await Moye.logout();
      renderAccount();
      Moye.toast(Moye.current() && Moye.current().locked ? t('lock-ok') : t('logout-ok'));
      notifyAuth();
    };
    if (s.agent_id) {
      Moye.api('/api/agents/' + encodeURIComponent(s.agent_id)).then((d) => {
        const el = document.getElementById('acct-home');
        if (el && d.agent && d.agent.home_node) el.textContent = 'home: ' + d.agent.home_node;
      }).catch(() => {});
    }
  }

  async function doEnablePasskey() {
    try {
      if (!(await Moye.passkeyAvailable())) {
        return Moye.toast('Passkeys are not available in this browser/device', 'error');
      }
      await Moye.enablePasskey();
      renderAccount();
      Moye.toast(t('passkey-ok'), 'success');
    } catch (e) {
      Moye.toast(e.message || String(e), 'error');
    }
  }
  async function doDisablePasskey() {
    try {
      await Moye.disablePasskey();
      renderAccount();
      Moye.toast(t('passkey-off'));
    } catch (e) {
      Moye.toast(e.message || String(e), 'error');
    }
  }
  async function doUnlockPasskey() {
    try {
      await Moye.unlockWithPasskey();
      renderAccount();
      Moye.toast(t('passkey-unlocked'), 'success');
      notifyAuth();
    } catch (e) {
      Moye.toast(e.message || String(e), 'error');
    }
  }

  function openRename() {
    const s = Moye.current();
    if (!s) return;
    modal(`<h3>${t('rename-title')}</h3>
      <p class="modal-sub">${t('rename-sub')}</p>
      <div class="field" style="margin-top:var(--sp-4)"><label>${t('reg-name')}</label>
        <input id="rn-name" value="${esc(s.name || '')}" maxlength="200"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="Moye.closeAccountModal()">${t('cancel')}</button>
        <button class="btn btn-primary" id="rn-go">${t('rename-go')}</button></div>`);
    document.getElementById('rn-go').onclick = doRename;
    document.getElementById('rn-name')?.focus();
  }

  async function doRename() {
    const btn = document.getElementById('rn-go');
    const name = (document.getElementById('rn-name')?.value || '').trim();
    if (!name) return Moye.toast(t('name-required'), 'error');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
    try {
      await Moye.updateProfile({ name });
      closeModal();
      renderAccount();
      Moye.toast(t('rename-ok'), 'success');
      notifyAuth();
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = t('rename-go'); }
      Moye.toast(e.message || String(e), 'error');
    }
  }

  function openDeregister() {
    const s = Moye.current();
    if (!s || !s.agent_id) return;
    modal(`<h3>${t('dereg-title')}</h3>
      <p class="modal-sub">${t('dereg-sub')}</p>
      <div class="warn-banner">⚠️ <span class="mono">${esc(s.agent_id)}</span></div>
      <div class="field"><label>${t('dereg-confirm')}</label>
        <input id="dg-confirm" type="text" autocomplete="off" spellcheck="false" placeholder="${esc(s.agent_id)}"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="dg-cancel">${t('cancel')}</button>
        <button type="button" class="btn btn-primary" id="dg-go" style="background:var(--accent-rose);border-color:var(--accent-rose)">${t('dereg-go')}</button>
      </div>`);
    document.getElementById('dg-cancel').onclick = () => closeModal();
    document.getElementById('dg-go').onclick = () => doDeregister(s.agent_id);
  }

  async function doDeregister(agentId) {
    const typed = (document.getElementById('dg-confirm')?.value || '').trim();
    if (typed !== agentId) return Moye.toast(t('dereg-mismatch'), 'error');
    const btn = document.getElementById('dg-go');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
    try {
      await Moye.api('/api/agents/' + encodeURIComponent(agentId) + '/deregister', {
        method: 'POST', body: {}, auth: true,
      });
      await Moye.forgetDevice();
      closeModal();
      renderAccount();
      Moye.toast(t('dereg-ok'), 'success');
      notifyAuth();
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = t('dereg-go'); }
      Moye.toast(e.message || String(e), 'error');
    }
  }

  function openRegister() {
    modal(`<h3>${t('reg-title')}</h3><p class="modal-sub">${t('reg-sub')}</p>
      <div class="field"><label>${t('reg-name')}</label><input id="r-name" placeholder="my_agent" maxlength="60"></div>
      <div class="field"><label>${t('reg-desc')}</label><input id="r-desc" maxlength="200"></div>
      <div class="field"><label>${t('reg-caps')}</label><input id="r-caps" placeholder="code, translate, research"></div>
      <div class="field"><label>${t('reg-endpoint')}</label><input id="r-ep" placeholder="https://my.agent"></div>
      <div class="field"><label>${t('reg-pass')}</label><input id="r-pass" type="password" autocomplete="new-password">
        <div class="hint">${t('reg-pass-hint')}</div></div>
      <div class="field"><label>${t('reg-pass2')}</label><input id="r-pass2" type="password" autocomplete="new-password"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="r-cancel">${t('cancel')}</button>
        <button type="button" class="btn btn-primary" id="r-go">${t('reg-submit')}</button></div>`);
    document.getElementById('r-cancel').onclick = () => closeModal();
    document.getElementById('r-go').onclick = () => doRegister();
  }

  async function doRegister() {
    const btn = document.getElementById('r-go');
    const name = document.getElementById('r-name').value.trim();
    if (!name) return Moye.toast(t('name-required'), 'error');
    const pass = document.getElementById('r-pass').value;
    const pass2 = document.getElementById('r-pass2').value;
    if (pass.length < 8) return Moye.toast(t('pass-short'), 'error');
    if (pass !== pass2) return Moye.toast(t('pass-mismatch'), 'error');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    try {
      await Moye.register({
        name,
        description: document.getElementById('r-desc').value.trim(),
        capabilities: document.getElementById('r-caps').value.split(',').map((s) => s.trim()).filter(Boolean),
        endpoint: document.getElementById('r-ep').value.trim(),
        passphrase: pass,
      });
      renderAccount();
      showBackupPrompt();
      Moye.toast(t('reg-ok'), 'success');
      notifyAuth();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = t('reg-submit');
      Moye.toast(e.message, 'error');
    }
  }

  function showBackupPrompt() {
    modal(`<h3>${t('backup-title')}</h3><p class="modal-sub">${t('backup-sub')}</p>
      <div class="warn-banner">⚠️ <span>${t('backup-warn')}</span></div>
      <p class="modal-sub" style="margin-top:var(--sp-3)">${t('passkey-hint')}</p>
      <div class="modal-actions">
        <button type="button" class="btn btn-primary" id="bk-dl">💾 ${t('backup-download')}</button>
        <button type="button" class="btn" id="bk-passkey">🪪 ${t('passkey-enable')}</button>
        <button type="button" class="btn" id="bk-done">${t('backup-done')}</button></div>`);
    document.getElementById('bk-dl').onclick = () => dlBackup();
    document.getElementById('bk-passkey').onclick = async () => {
      try {
        await Moye.enablePasskey();
        Moye.toast(t('passkey-ok'), 'success');
      } catch (e) { Moye.toast(e.message || String(e), 'error'); }
    };
    document.getElementById('bk-done').onclick = () => closeModal();
  }

  function openLogin() {
    modal(`<h3>${t('login-title')}</h3><p class="modal-sub">${t('login-sub')}</p>
      <div class="dropzone" id="dz">
        <div style="font-size:1.6rem;margin-bottom:.4rem">🔑</div><div>${t('login-drop')}</div></div>
      <input type="file" id="keyfile" accept=".json,application/json" hidden>
      <div class="field" id="lg-pass-wrap" style="display:none;margin-top:var(--sp-4)">
        <label>${t('login-pass')}</label><input id="lg-pass" type="password" autocomplete="current-password">
        <div class="hint" id="lg-which"></div>
        <button type="button" class="btn btn-primary btn-block" style="margin-top:var(--sp-3)" id="lg-go">${t('login-submit')}</button>
      </div>
      <details style="margin-top:var(--sp-4)">
        <summary style="cursor:pointer;color:var(--text-muted);font-size:var(--fs-sm)">${t('login-paste')}</summary>
        <div class="field" style="margin-top:var(--sp-3)"><textarea id="k-priv" rows="4" placeholder="-----BEGIN PRIVATE KEY-----"></textarea></div>
        <div class="field"><textarea id="k-pub" rows="3" placeholder="-----BEGIN PUBLIC KEY-----"></textarea>
          <div class="hint">${t('login-need-pub')}</div></div>
        <button type="button" class="btn btn-block" id="lg-paste">${t('login-submit')}</button>
      </details>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" id="lg-cancel">${t('cancel')}</button></div>`);
    const dz = document.getElementById('dz');
    const keyfile = document.getElementById('keyfile');
    dz.onclick = () => keyfile.click();
    keyfile.onchange = () => pickFile(keyfile.files[0]);
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) pickFile(f); });
    document.getElementById('lg-go').onclick = () => doFileLogin();
    document.getElementById('lg-paste').onclick = () => pasteLogin();
    document.getElementById('lg-cancel').onclick = () => closeModal();
  }

  async function pickFile(file) {
    if (!file) return;
    pendingFile = file;
    const info = await Moye.inspectBackupFile(file);
    document.getElementById('lg-pass-wrap').style.display = '';
    document.getElementById('lg-which').textContent = info && info.name ? `${info.name} · ${Moye.shortDid(info.did)}` : '';
    document.getElementById('lg-pass').focus();
  }

  async function doFileLogin() {
    const pass = document.getElementById('lg-pass').value;
    if (!pass) return Moye.toast(t('pass-required'), 'error');
    const b = document.getElementById('lg-go');
    b.disabled = true;
    b.innerHTML = '<span class="spinner"></span>';
    try {
      await Moye.loginWithBackupFile(pendingFile, pass);
      afterLogin();
    } catch (e) {
      b.disabled = false;
      b.textContent = t('login-submit');
      Moye.toast(e.message, 'error');
    }
  }

  async function pasteLogin() {
    try {
      await Moye.loginWithKey(document.getElementById('k-priv').value, document.getElementById('k-pub').value);
      afterLogin();
    } catch (e) {
      Moye.toast(e.message, 'error');
    }
  }

  function afterLogin() {
    closeModal();
    renderAccount();
    Moye.toast(t('login-ok'), 'success');
    notifyAuth();
  }

  async function dlBackup() {
    try { await Moye.downloadBackup(); }
    catch (e) { Moye.toast(e.message, 'error'); }
  }

  function openSetPass() {
    modal(`<h3>${t('set-pass')}</h3><p class="modal-sub">${t('set-pass-sub')}</p>
      <div class="field"><label>${t('reg-pass')}</label><input id="sp-pass" type="password" autocomplete="new-password"></div>
      <div class="field"><label>${t('reg-pass2')}</label><input id="sp-pass2" type="password" autocomplete="new-password"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="sp-cancel">${t('cancel')}</button>
        <button type="button" class="btn btn-primary" id="sp-go">${t('set-pass')}</button></div>`);
    document.getElementById('sp-cancel').onclick = () => closeModal();
    document.getElementById('sp-go').onclick = async () => {
      const p = document.getElementById('sp-pass').value;
      const p2 = document.getElementById('sp-pass2').value;
      if (p.length < 8) return Moye.toast(t('pass-short'), 'error');
      if (p !== p2) return Moye.toast(t('pass-mismatch'), 'error');
      try {
        await Moye.setBackupPassphrase(p);
        closeModal();
        renderAccount();
        Moye.toast(t('backup-ok'), 'success');
      } catch (e) {
        Moye.toast(e.message, 'error');
      }
    };
  }

  function mountAccount(options = {}) {
    opts = options || {};
    if (!wired) {
      document.addEventListener('click', closeMenu);
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
      wired = true;
    }
    renderAccount();
  }

  global.Moye = global.Moye || {};
  Object.assign(global.Moye, {
    mountAccount,
    renderAccount,
    openLogin,
    openRegister,
    closeAccountModal: closeModal,
  });
})(window);
