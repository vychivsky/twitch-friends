import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './errors';
import { verifyFirebaseIdentity } from './firebaseAuth';
import { syncFriendshipNodes } from './firebaseDatabase';
import worker from './index';
import { listFriendshipEdges, removeFriendConnection } from './repository';
import type { Env } from './types';

vi.mock('./firebaseAuth');
vi.mock('./firebaseDatabase');
vi.mock('./rateLimit');
vi.mock('./repository');

const database = {} as D1Database;
const env: Env = {
  ALLOWED_EXTENSION_ORIGINS: 'chrome-extension://allowed',
  ALLOW_INSECURE_EMULATOR_AUTH: 'true',
  ASSETS: {} as Fetcher,
  DB: database,
  FIREBASE_PROJECT_ID: 'demo-twitch-friends',
  TWITCH_CLIENT_ID: 'test-client',
  TWITCH_CLIENT_SECRET: 'test-secret',
  TWITCH_OAUTH_CALLBACK_URL: 'http://127.0.0.1:8787/oauth/callback',
};

const fetchWorker: ExportedHandlerFetchHandler<Env> = worker.fetch.bind(worker);

function deleteFriend(segment: string) {
  return fetchWorker(
    new Request(`https://api.example.test/api/friends/${segment}`, {
      headers: { Origin: 'chrome-extension://allowed' },
      method: 'DELETE',
    }),
    env,
    {} as ExecutionContext,
  );
}

describe('friend connection path validation', () => {
  beforeEach(() => {
    vi.mocked(verifyFirebaseIdentity).mockResolvedValue({ uid: 'alice-uid' });
    vi.mocked(listFriendshipEdges).mockResolvedValue([]);
  });

  it.each(['%', '%ZZ', '%E0%A4%A', '%FF'])('rejects malformed encoding %s', async (segment) => {
    const response = await deleteFriend(segment);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: 'invalid-argument', message: 'Friend connection is invalid.' },
    });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('chrome-extension://allowed');
    expect(removeFriendConnection).not.toHaveBeenCalled();
    expect(syncFriendshipNodes).not.toHaveBeenCalled();
  });

  it.each(['bob%2Fuid', 'bob%00uid'])('validates decoded connection %s', async (segment) => {
    expect((await deleteFriend(segment)).status).toBe(400);
    expect(removeFriendConnection).not.toHaveBeenCalled();
  });

  it.each(['bob-uid', 'bob%2Duid'])('accepts valid connection %s', async (segment) => {
    expect((await deleteFriend(segment)).status).toBe(200);
    expect(removeFriendConnection).toHaveBeenCalledWith(database, 'alice-uid', 'bob-uid');
  });

  it('still requires authentication before processing the connection', async () => {
    vi.mocked(verifyFirebaseIdentity).mockRejectedValue(
      new ApiError(401, 'unauthenticated', 'Sign in.'),
    );

    expect((await deleteFriend('%')).status).toBe(401);
    expect(removeFriendConnection).not.toHaveBeenCalled();
  });
});
