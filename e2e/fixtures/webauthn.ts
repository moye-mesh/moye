import { CDPSession, Page } from '@playwright/test';

/**
 * CDP virtual authenticator helpers for P4-1 (WebAuthn PRF) e2e.
 * Requires Chromium DevTools Protocol WebAuthn.hasPrf support.
 */

export type VirtualAuthenticatorOpts = {
  hasPrf?: boolean;
  hasUserVerification?: boolean;
  hasResidentKey?: boolean;
  isUserVerified?: boolean;
  transport?: 'internal' | 'usb' | 'ble' | 'nfc';
  protocol?: 'ctap2' | 'u2f';
};

export async function enableWebAuthn(page: Page): Promise<CDPSession> {
  const client = await page.context().newCDPSession(page);
  await client.send('WebAuthn.enable', { enableUI: false });
  return client;
}

export async function addVirtualAuthenticator(
  client: CDPSession,
  opts: VirtualAuthenticatorOpts = {},
): Promise<string> {
  const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: opts.protocol || 'ctap2',
      transport: opts.transport || 'internal',
      hasResidentKey: opts.hasResidentKey !== false,
      hasUserVerification: opts.hasUserVerification !== false,
      hasPrf: !!opts.hasPrf,
      automaticPresenceSimulation: true,
      isUserVerified: opts.isUserVerified !== false,
    },
  });
  return authenticatorId as string;
}

export async function removeVirtualAuthenticator(client: CDPSession, authenticatorId: string) {
  await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
}

export async function clearCredentials(client: CDPSession, authenticatorId: string) {
  await client.send('WebAuthn.clearCredentials', { authenticatorId });
}

/** Read the IndexedDB identity record (serializable fields only). */
export async function readIdbIdentity(page: Page) {
  return page.evaluate(async () => {
    const open = indexedDB.open('moye-identity', 1);
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      open.onupgradeneeded = () => {
        const d = open.result;
        if (!d.objectStoreNames.contains('session')) d.createObjectStore('session');
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const tx = db.transaction('session', 'readonly');
    const store = tx.objectStore('session');
    const rec: any = await new Promise((resolve, reject) => {
      const g = store.get('current');
      g.onsuccess = () => resolve(g.result || null);
      g.onerror = () => reject(g.error);
    });
    db.close();
    if (!rec) return null;
    return {
      did: rec.did || null,
      agent_id: rec.agent_id || null,
      name: rec.name || null,
      hasPrivKey: !!rec.privKey,
      privKeyExtractable: rec.privKey ? !!rec.privKey.extractable : null,
      hasPasskey: !!rec.passkey,
      passkeyCredentialId: rec.passkey && rec.passkey.credentialId ? String(rec.passkey.credentialId) : null,
      hasPasskeyCiphertext: !!(rec.passkey && rec.passkey.ciphertext),
      hasBackup: !!rec.backup,
      hasBackupCiphertext: !!(rec.backup && rec.backup.ciphertext),
      // Fail loudly if plaintext PEM somehow landed in IDB.
      suspiciousPemKeys: Object.keys(rec).filter((k) => {
        const v = rec[k];
        return typeof v === 'string' && /BEGIN (PRIVATE|ENCRYPTED) KEY/.test(v);
      }),
    };
  });
}

/** Attempt to export the live signing CryptoKey from IndexedDB — must reject when non-extractable. */
export async function tryExportStoredPrivKey(page: Page): Promise<{ ok: boolean; error?: string }> {
  return page.evaluate(async () => {
    const open = indexedDB.open('moye-identity', 1);
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const tx = db.transaction('session', 'readonly');
    const rec: any = await new Promise((resolve, reject) => {
      const g = tx.objectStore('session').get('current');
      g.onsuccess = () => resolve(g.result || null);
      g.onerror = () => reject(g.error);
    });
    db.close();
    if (!rec || !rec.privKey) return { ok: false, error: 'no privKey in IDB' };
    try {
      await crypto.subtle.exportKey('pkcs8', rec.privKey);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e && e.message ? String(e.message) : String(e) };
    }
  });
}
