import { expect, test } from '@playwright/test';
import { DirectoryPage } from '../pages/DirectoryPage';
import {
  addVirtualAuthenticator,
  clearCredentials,
  enableWebAuthn,
  readIdbIdentity,
  removeVirtualAuthenticator,
  tryExportStoredPrivKey,
} from '../fixtures/webauthn';

/**
 * P4-1: Passkey / WebAuthn PRF unlock — real end-to-end against Chromium virtual authenticator.
 * Proves happy path, non-extractable storage, passphrase fallback, and wrong-credential failure.
 */

const PASS = 'e2e-passkey-passphrase-ok';

async function registerViaMoye(page: import('@playwright/test').Page, name: string, passphrase = PASS) {
  await page.goto('/directory');
  await page.waitForFunction(() => !!(window as any).Moye && typeof (window as any).Moye.register === 'function');
  const session = await page.evaluate(async ({ name, passphrase }) => {
    const Moye = (window as any).Moye;
    await Moye.ready();
    const cur = await Moye.register({
      name,
      description: 'P4-1 e2e',
      capabilities: ['e2e', 'passkey'],
      passphrase,
    });
    return {
      did: cur.did,
      agent_id: cur.agent_id,
      recoverable: !!cur.recoverable,
      hasPasskey: !!Moye.hasPasskey(),
    };
  }, { name, passphrase });
  return session;
}

test.describe('P4-1 Passkey / WebAuthn PRF', () => {
  test('registration + PRF unlock restores a working signing key', async ({ page }) => {
    const client = await enableWebAuthn(page);
    const authenticatorId = await addVirtualAuthenticator(client, { hasPrf: true });

    const name = `e2e-pk-happy-${Date.now()}`;
    const session = await registerViaMoye(page, name);
    expect(session.agent_id).toBeTruthy();
    expect(session.did).toMatch(/^did:moye:/);

    await page.evaluate(async () => {
      const Moye = (window as any).Moye;
      await Moye.enablePasskey();
    });
    expect(await page.evaluate(() => (window as any).Moye.hasPasskey())).toBe(true);

    const idbBeforeLock = await readIdbIdentity(page);
    expect(idbBeforeLock?.hasPasskeyCiphertext).toBe(true);
    expect(idbBeforeLock?.privKeyExtractable).toBe(false);

    await page.evaluate(async () => {
      await (window as any).Moye.lockSession();
    });
    expect(await page.evaluate(() => (window as any).Moye.isLocked())).toBe(true);
    expect(await page.evaluate(() => (window as any).Moye.isRecoverable())).toBe(false);

    await page.evaluate(async () => {
      await (window as any).Moye.unlockWithPasskey();
    });
    expect(await page.evaluate(() => (window as any).Moye.isLocked())).toBe(false);
    expect(await page.evaluate(() => (window as any).Moye.isRecoverable())).toBe(true);

    // Network proof: DID-signed inbox read must succeed with the unlocked key.
    const inboxOk = await page.evaluate(async () => {
      const Moye = (window as any).Moye;
      const cur = Moye.current();
      const r = await Moye.api('/api/agents/' + cur.agent_id + '/inbox', { method: 'GET', auth: true });
      return !!(r && r.success !== false);
    });
    expect(inboxOk).toBe(true);

    await removeVirtualAuthenticator(client, authenticatorId);
  });

  test('stored private key is never extractable; IDB holds ciphertext only', async ({ page }) => {
    const client = await enableWebAuthn(page);
    await addVirtualAuthenticator(client, { hasPrf: true });

    const name = `e2e-pk-extract-${Date.now()}`;
    await registerViaMoye(page, name);
    await page.evaluate(async () => { await (window as any).Moye.enablePasskey(); });

    const idb = await readIdbIdentity(page);
    expect(idb).toBeTruthy();
    expect(idb!.privKeyExtractable).toBe(false);
    expect(idb!.hasPasskeyCiphertext).toBe(true);
    expect(idb!.hasBackupCiphertext).toBe(true);
    expect(idb!.suspiciousPemKeys).toEqual([]);

    const exported = await tryExportStoredPrivKey(page);
    expect(exported.ok, `exportKey must fail for non-extractable key; got ${JSON.stringify(exported)}`).toBe(false);

    // pendingPrivDer must not be exposed on window.Moye
    const leaked = await page.evaluate(() => {
      const M = (window as any).Moye;
      return !!(M.pendingPrivDer || M._pendingPrivDer || M.privDer);
    });
    expect(leaked).toBe(false);

    // After soft-lock, live key is gone from IDB but wrap remains.
    await page.evaluate(async () => { await (window as any).Moye.lockSession(); });
    const locked = await readIdbIdentity(page);
    expect(locked!.hasPrivKey).toBe(false);
    expect(locked!.hasPasskeyCiphertext).toBe(true);
    expect(locked!.suspiciousPemKeys).toEqual([]);
  });

  test('passphrase backup fallback works when PRF is unavailable', async ({ page }) => {
    // Authenticator without PRF — enablePasskey must fail; backup path must still work.
    const client = await enableWebAuthn(page);
    await addVirtualAuthenticator(client, { hasPrf: false });

    const name = `e2e-pk-fallback-${Date.now()}`;
    await registerViaMoye(page, name);

    const enableErr = await page.evaluate(async () => {
      try {
        await (window as any).Moye.enablePasskey();
        return null;
      } catch (e: any) {
        return e && e.message ? String(e.message) : String(e);
      }
    });
    expect(enableErr).toBeTruthy();
    expect(enableErr!).toMatch(/PRF|authenticator|Passkey/i);
    expect(await page.evaluate(() => (window as any).Moye.hasPasskey())).toBe(false);

    const backupJson = await page.evaluate(async () => {
      const Moye = (window as any).Moye;
      // downloadBackup triggers a download; reconstruct the same payload via IDB backup field.
      const open = indexedDB.open('moye-identity', 1);
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const rec: any = await new Promise((resolve, reject) => {
        const g = db.transaction('session', 'readonly').objectStore('session').get('current');
        g.onsuccess = () => resolve(g.result);
        g.onerror = () => reject(g.error);
      });
      db.close();
      return rec && rec.backup ? JSON.stringify(rec.backup) : null;
    });
    expect(backupJson).toBeTruthy();

    await page.evaluate(async () => { await (window as any).Moye.forgetDevice(); });
    expect(await page.evaluate(() => (window as any).Moye.isLoggedIn())).toBe(false);

    const wrong = await page.evaluate(async ({ backupJson }) => {
      const file = new File([backupJson], 'id.json', { type: 'application/json' });
      try {
        await (window as any).Moye.loginWithBackupFile(file, 'definitely-wrong-passphrase');
        return null;
      } catch (e: any) {
        return e && e.message ? String(e.message) : String(e);
      }
    }, { backupJson });
    expect(wrong).toMatch(/Wrong passphrase/i);
    expect(await page.evaluate(() => (window as any).Moye.isLoggedIn())).toBe(false);

    await page.evaluate(async ({ backupJson, PASS }) => {
      const file = new File([backupJson], 'id.json', { type: 'application/json' });
      await (window as any).Moye.loginWithBackupFile(file, PASS);
    }, { backupJson, PASS });
    expect(await page.evaluate(() => (window as any).Moye.isRecoverable())).toBe(true);

    const inboxOk = await page.evaluate(async () => {
      const Moye = (window as any).Moye;
      const cur = Moye.current();
      const r = await Moye.api('/api/agents/' + cur.agent_id + '/inbox', { method: 'GET', auth: true });
      return !!(r && r.success !== false);
    });
    expect(inboxOk).toBe(true);
  });

  test('wrong or absent credential FAILS to unlock (does not unlock unconditionally)', async ({ page }) => {
    const client = await enableWebAuthn(page);
    const authA = await addVirtualAuthenticator(client, { hasPrf: true });

    const name = `e2e-pk-fail-${Date.now()}`;
    await registerViaMoye(page, name);
    await page.evaluate(async () => { await (window as any).Moye.enablePasskey(); });
    await page.evaluate(async () => { await (window as any).Moye.lockSession(); });
    expect(await page.evaluate(() => (window as any).Moye.isLocked())).toBe(true);

    // Remove the credential that can produce the PRF secret.
    await clearCredentials(client, authA);
    // Also add a fresh authenticator so the browser has *some* UV platform auth — but not the enrolled one.
    await removeVirtualAuthenticator(client, authA);
    await addVirtualAuthenticator(client, { hasPrf: true });

    const unlockErr = await page.evaluate(async () => {
      try {
        await (window as any).Moye.unlockWithPasskey();
        return null;
      } catch (e: any) {
        return e && e.message ? String(e.message) : String(e);
      }
    });
    expect(unlockErr, 'unlockWithPasskey must throw when credential is absent').toBeTruthy();
    expect(await page.evaluate(() => (window as any).Moye.isLocked())).toBe(true);
    expect(await page.evaluate(() => (window as any).Moye.isRecoverable())).toBe(false);

    // Soft-lock may keep a Bearer token for non-DID calls — the security property is that the
    // signing key was NOT restored. Assert IDB still has no live privKey and unlock stays failing.
    const idb = await readIdbIdentity(page);
    expect(idb!.hasPrivKey).toBe(false);
    expect(idb!.hasPasskeyCiphertext).toBe(true);

    const unlockAgain = await page.evaluate(async () => {
      try {
        await (window as any).Moye.unlockWithPasskey();
        return 'unlocked';
      } catch {
        return 'failed';
      }
    });
    expect(unlockAgain).toBe('failed');
    expect(await page.evaluate(() => (window as any).Moye.isRecoverable())).toBe(false);
  });

  // Sanity: DirectoryPage register path still works alongside Passkey APIs (no conflict).
  test('UI register still works with a PRF virtual authenticator present', async ({ page }) => {
    const client = await enableWebAuthn(page);
    await addVirtualAuthenticator(client, { hasPrf: true });
    const dir = new DirectoryPage(page);
    await dir.goto();
    const name = `e2e-pk-ui-${Date.now()}`;
    await dir.registerAgent({ name, passphrase: PASS });
    await dir.waitForAgentVisible(name);
  });
});
