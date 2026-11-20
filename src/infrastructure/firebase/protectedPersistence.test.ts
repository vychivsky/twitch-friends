import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => new Map<string, unknown>());

vi.mock('firebase/auth/web-extension', () => {
  class FakeIndexedDBPersistence {
    static readonly type = 'LOCAL';

    _get(key: string) {
      return Promise.resolve(storage.get(key) ?? null);
    }

    _remove(key: string) {
      storage.delete(key);
      return Promise.resolve();
    }
  }

  return { indexedDBLocalPersistence: FakeIndexedDBPersistence };
});

import {
  hasStoredCredential,
  protectedPersistence,
  removeStoredCredential,
  withCredentialRemoval,
} from '@/infrastructure/firebase/protectedPersistence';

type Store = {
  _get(key: string): Promise<unknown>;
  _remove(key: string): Promise<void>;
};

const auth = { config: { apiKey: 'api-key' }, name: '[DEFAULT]' } as never;
const credentialKey = 'firebase:authUser:api-key:[DEFAULT]';

function createStore() {
  return new (protectedPersistence as unknown as new () => Store)();
}

describe('protected Firebase persistence', () => {
  beforeEach(() => {
    storage.clear();
    storage.set(credentialKey, { uid: 'persisted-user' });
    storage.set('firebase:other', true);
  });

  it('refuses implicit removal of the stored credential', async () => {
    const store = createStore();

    await store._remove(credentialKey);

    expect(storage.has(credentialKey)).toBe(true);
    await expect(hasStoredCredential(auth)).resolves.toBe(true);
  });

  it('still removes unrelated persistence keys', async () => {
    const store = createStore();

    await store._remove('firebase:other');

    expect(storage.has('firebase:other')).toBe(false);
  });

  it('removes the credential during an explicit sign-out or deletion', async () => {
    const store = createStore();

    await withCredentialRemoval(() => store._remove(credentialKey));

    expect(storage.has(credentialKey)).toBe(false);
  });

  it('closes the removal window after the explicit operation fails', async () => {
    const store = createStore();

    await expect(
      withCredentialRemoval(() => Promise.reject(new Error('delete failed'))),
    ).rejects.toThrow('delete failed');
    await store._remove(credentialKey);

    expect(storage.has(credentialKey)).toBe(true);
  });

  it('removes an unrestorable credential on request', async () => {
    createStore();

    await removeStoredCredential(auth);

    await expect(hasStoredCredential(auth)).resolves.toBe(false);
  });
});
