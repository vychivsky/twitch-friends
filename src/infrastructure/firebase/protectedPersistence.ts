import {
  indexedDBLocalPersistence,
  type Auth,
  type Persistence,
} from 'firebase/auth/web-extension';

type PersistenceStore = {
  _get(key: string): Promise<unknown>;
  _remove(key: string): Promise<void>;
};

type PersistenceStoreClass = new () => PersistenceStore;

const IndexedDBPersistence = indexedDBLocalPersistence as unknown as PersistenceStoreClass;
const credentialKeyPrefix = 'firebase:authUser:';

let credentialRemovalAllowed = false;
let activeStore: PersistenceStore | null = null;

function registerActiveStore(store: PersistenceStore) {
  activeStore = store;
}

class ProtectedIndexedDBPersistence extends IndexedDBPersistence {
  static readonly type = 'LOCAL';

  constructor() {
    super();
    registerActiveStore(this);
  }

  override async _remove(key: string) {
    if (key.startsWith(credentialKeyPrefix) && !credentialRemovalAllowed) {
      return;
    }

    await super._remove(key);
  }
}

export const protectedPersistence = ProtectedIndexedDBPersistence as unknown as Persistence;

function credentialKey(auth: Auth) {
  return `${credentialKeyPrefix}${auth.config.apiKey}:${auth.name}`;
}

function requireStore() {
  if (!activeStore) {
    throw new Error('Firebase persistence is not initialized.');
  }

  return activeStore;
}

export async function hasStoredCredential(auth: Auth) {
  return Boolean(await requireStore()._get(credentialKey(auth)));
}

export async function withCredentialRemoval<T>(operation: () => Promise<T>) {
  credentialRemovalAllowed = true;

  try {
    return await operation();
  } finally {
    credentialRemovalAllowed = false;
  }
}

export async function removeStoredCredential(auth: Auth) {
  const store = requireStore();

  await withCredentialRemoval(() => store._remove(credentialKey(auth)));
}

export function isProtectedPersistenceSupported() {
  const prototype = IndexedDBPersistence.prototype as Partial<PersistenceStore>;

  return typeof prototype._get === 'function' && typeof prototype._remove === 'function';
}
