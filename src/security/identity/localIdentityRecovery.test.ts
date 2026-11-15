import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  deleteLocalIdentity,
  readLocalIdentity,
  writeLocalIdentity,
} from '@/security/identity/identityDatabase';
import type { LocalIdentity } from '@/security/identity/localIdentityTypes';

async function loadIdentityModule() {
  vi.resetModules();

  return import('@/security/identity/localIdentity');
}

describe('local identity recovery', () => {
  afterEach(async () => {
    vi.doUnmock('@/security/identity/identityDatabase');
    await deleteLocalIdentity();
  });

  it('restores the same non-extractable private key after a restart', async () => {
    const firstRun = await loadIdentityModule();
    const created = await firstRun.getOrCreateLocalIdentity();

    const restarted = await loadIdentityModule();
    const restored = await restarted.getOrCreateLocalIdentity();

    expect(restored.encryptionPublicKey).toEqual(created.encryptionPublicKey);
    expect(restored.encryptionPrivateKey.extractable).toBe(false);
  });

  it('replaces a corrupted identity record with a usable key', async () => {
    await writeLocalIdentity({
      createdAt: Date.now(),
      encryptionPrivateKey: 'not-a-key',
      encryptionPublicKey: { crv: 'P-256', kty: 'EC', x: 'short', y: 'short' },
      version: 1,
    } as unknown as LocalIdentity);

    const identityModule = await loadIdentityModule();
    const identity = await identityModule.getOrCreateLocalIdentity();

    expect(identityModule.isUsableLocalIdentity(identity)).toBe(true);
    expect(identityModule.isUsableLocalIdentity(await readLocalIdentity())).toBe(true);
  });

  it('does not create a new key when the identity store cannot be read', async () => {
    const write = vi.fn();

    vi.doMock('@/security/identity/identityDatabase', () => ({
      readLocalIdentity: () => Promise.reject(new Error('IndexedDB is unavailable')),
      writeLocalIdentity: write,
    }));

    const identityModule = await loadIdentityModule();

    await expect(identityModule.getOrCreateLocalIdentity()).rejects.toThrow(
      'IndexedDB is unavailable',
    );
    expect(write).not.toHaveBeenCalled();
  });
});
