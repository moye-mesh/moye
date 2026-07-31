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
    const name = s.name || s.agent_id;
    const showProfile = typeof opts.onShowProfile === 'function';
    host.innerHTML = `
      <button type="button" class="avatar" id="acct-avatar" style="background:${Moye.avatarColor(s.agent_id || name)};border:none;cursor:pointer" title="${esc(name)}">${esc(Moye.initials(name))}</button>
      <div class="account-menu" id="acct-menu">
        <div class="account-head">
          <div style="font-weight:650;margin-bottom:.15rem">${esc(name)}</div>
          <div class="mono muted" style="font-size:var(--fs-xs);overflow-wrap:anywhere">${esc(s.did ? Moye.shortDid(s.did) : s.agent_id)}</div>
          ${Moye.isRecoverable() ? `<div class="badge badge-emerald" style="margin-top:.4rem;font-size:10px">🔒 ${t('nonextractable')}</div>` : ''}
          ${!Moye.isRecoverable() ? `<div class="badge badge-amber" style="margin-top:.5rem">token-only</div>` : ''}
        </div>
        ${Moye.isRecoverable() && Moye.hasBackup() ? `<button type="button" class="menu-item" id="acct-dl">💾 ${t('backup-download')}</button>` : ''}
        ${Moye.isRecoverable() && !Moye.hasBackup() ? `<button type="button" class="menu-item" id="acct-setpass">🔑 ${t('set-pass')}</button>` : ''}
        ${showProfile ? `<button type="button" class="menu-item" id="acct-detail">👤 ${t('detail')}</button>` : ''}
        <button type="button" class="menu-item danger" id="acct-logout">🚪 ${t('logout')}</button>
      </div>`;
    host.querySelector('#acct-avatar').onclick = (e) => {
      e.stopPropagation();
      document.getElementById('acct-menu').classList.toggle('show');
    };
    host.querySelector('#acct-menu').onclick = (e) => e.stopPropagation();
    host.querySelector('#acct-dl')?.addEventListener('click', () => dlBackup());
    host.querySelector('#acct-setpass')?.addEventListener('click', () => { closeMenu(); openSetPass(); });
    host.querySelector('#acct-detail')?.addEventListener('click', () => {
      closeMenu();
      opts.onShowProfile(s.agent_id);
    });
    host.querySelector('#acct-logout').onclick = async () => {
      await Moye.logout();
      renderAccount();
      Moye.toast(t('logout-ok'));
      notifyAuth();
    };
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
      <div class="modal-actions">
        <button type="button" class="btn btn-primary" id="bk-dl">💾 ${t('backup-download')}</button>
        <button type="button" class="btn" id="bk-done">${t('backup-done')}</button></div>`);
    document.getElementById('bk-dl').onclick = () => dlBackup();
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
