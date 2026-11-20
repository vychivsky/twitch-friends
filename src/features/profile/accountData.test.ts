import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  acceptPrivacyConsent: vi.fn(() => Promise.resolve()),
  clearRealtimeAccountData: vi.fn(() => Promise.resolve()),
  clearStorage: vi.fn(() => Promise.resolve()),
  deleteFirebaseAccount: vi.fn(() => Promise.resolve()),
  deleteLocalIdentity: vi.fn(() => Promise.resolve()),
  isAccountSetupRequired: vi.fn(() => Promise.resolve(false)),
  reload: vi.fn(),
  requestBackend: vi.fn(),
  requireAccountSetup: vi.fn(() => Promise.resolve()),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: { reload: mocks.reload },
    storage: { local: { clear: mocks.clearStorage } },
  },
}));

vi.mock('@/features/profile/accountState', () => ({
  isAccountSetupRequired: mocks.isAccountSetupRequired,
  requireAccountSetup: mocks.requireAccountSetup,
}));

vi.mock('@/features/privacy/privacyConsent', () => ({
  acceptPrivacyConsent: mocks.acceptPrivacyConsent,
}));

vi.mock('@/features/presence/friendshipEdges', () => ({
  clearRealtimeAccountData: mocks.clearRealtimeAccountData,
}));

vi.mock('@/infrastructure/backend/backendApi', () => ({
  BackendError: class BackendError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
  requestBackend: mocks.requestBackend,
}));

vi.mock('@/infrastructure/firebase/firebaseAuth', () => ({
  deleteFirebaseAccount: mocks.deleteFirebaseAccount,
}));

vi.mock('@/security/identity/identityDatabase', () => ({
  deleteLocalIdentity: mocks.deleteLocalIdentity,
}));

import { deleteMyData, disconnectTwitch } from '@/features/profile/accountData';

describe('account disconnect and deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAccountSetupRequired.mockResolvedValue(false);
    mocks.requestBackend.mockResolvedValue({ friendIds: ['friend-1'], success: true });
  });

  it('disconnects Twitch but keeps the anonymous session and private key', async () => {
    await disconnectTwitch();

    expect(mocks.requestBackend).toHaveBeenCalledWith('/api/account/disconnect', {
      method: 'POST',
    });
    expect(mocks.clearRealtimeAccountData).toHaveBeenCalledWith(['friend-1']);
    expect(mocks.clearStorage).toHaveBeenCalled();
    expect(mocks.acceptPrivacyConsent).toHaveBeenCalled();
    expect(mocks.deleteFirebaseAccount).not.toHaveBeenCalled();
    expect(mocks.deleteLocalIdentity).not.toHaveBeenCalled();
    expect(mocks.reload).toHaveBeenCalled();
  });

  it('deletes server data, the Firebase user, the private key, and local storage', async () => {
    await deleteMyData();

    expect(mocks.requestBackend).toHaveBeenCalledWith('/api/account', { method: 'DELETE' });
    expect(mocks.clearRealtimeAccountData).toHaveBeenCalledWith(['friend-1']);
    expect(mocks.deleteFirebaseAccount).toHaveBeenCalled();
    expect(mocks.deleteLocalIdentity).toHaveBeenCalled();
    expect(mocks.clearStorage).toHaveBeenCalled();
    expect(mocks.requireAccountSetup).toHaveBeenCalled();
    expect(mocks.reload).toHaveBeenCalled();
  });

  it('stops before local cleanup when the server rejects the deletion', async () => {
    mocks.requestBackend.mockRejectedValue(new Error('offline'));

    await expect(deleteMyData()).rejects.toThrow('offline');
    expect(mocks.deleteFirebaseAccount).not.toHaveBeenCalled();
    expect(mocks.deleteLocalIdentity).not.toHaveBeenCalled();
  });

  it('rejects malformed server responses before clearing presence', async () => {
    mocks.requestBackend.mockResolvedValue({ friendIds: ['../bad'], success: true });

    await expect(disconnectTwitch()).rejects.toThrow('Account backend returned invalid data.');
    expect(mocks.clearRealtimeAccountData).not.toHaveBeenCalled();
  });
});
