import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker from './index';
import { listFriendshipEdgesForUids } from './repository';
import type { Env } from './types';

type RecordedQuery = {
  query: string;
  values: unknown[];
};

const fullGraphMarker = 'ORDER BY friendships.user_a, friendships.user_b';

function base64Url(value: unknown) {
  return btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function emulatorToken(uid: string) {
  const now = Math.floor(Date.now() / 1_000);

  return `${base64Url({ alg: 'none', typ: 'JWT' })}.${base64Url({
    aud: 'demo-twitch-friends',
    auth_time: now,
    exp: now + 3_600,
    firebase: { sign_in_provider: 'anonymous' },
    iat: now,
    iss: 'https://securetoken.google.com/demo-twitch-friends',
    sub: uid,
  })}.`;
}

function createDatabase(queries: RecordedQuery[]) {
  const respond = (query: string) => ({
    all: () => {
      if (query.includes('json_each')) {
        return Promise.resolve({
          results: [{ user_a_uid: 'alice-uid', user_b_uid: 'bob-uid' }],
        });
      }

      return Promise.resolve({ results: [] });
    },
    first: () => {
      if (query.includes('rate_limits') || query.includes('daily_usage')) {
        return Promise.resolve({ count: 1 });
      }

      if (query.includes('FROM users') && query.includes('firebase_uid = ?')) {
        return Promise.resolve({
          avatar_url: '',
          display_name: 'Alice',
          firebase_uid: 'alice-uid',
          login: 'alice',
          twitch_id: '1',
        });
      }

      return Promise.resolve(null);
    },
    run: () => Promise.resolve({ success: true }),
  });

  return {
    batch: () => Promise.resolve([]),
    prepare(query: string) {
      return {
        ...respond(query),
        bind(...values: unknown[]) {
          queries.push({ query, values });
          return respond(query);
        },
      };
    },
  } as unknown as D1Database;
}

function createEnvironment(queries: RecordedQuery[]): Env {
  return {
    ALLOWED_EXTENSION_ORIGINS: 'chrome-extension://allowed',
    ALLOW_INSECURE_EMULATOR_AUTH: 'true',
    ASSETS: { fetch: () => Promise.resolve(new Response('Not Found', { status: 404 })) },
    DB: createDatabase(queries),
    FIREBASE_PROJECT_ID: 'demo-twitch-friends',
    TWITCH_CLIENT_ID: 'client-id',
    TWITCH_CLIENT_SECRET: 'client-secret',
    TWITCH_OAUTH_CALLBACK_URL: 'http://127.0.0.1:8787/oauth/callback',
  } as unknown as Env;
}

function apiRequest(path: string, method = 'GET') {
  return new Request(`https://api.example.test${path}`, {
    headers: {
      Authorization: `Bearer ${emulatorToken('alice-uid')}`,
      Origin: 'chrome-extension://allowed',
    },
    method,
  });
}

function createContext() {
  const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();

  return {
    context: {
      passThroughOnException: vi.fn(),
      props: {},
      waitUntil,
    } as unknown as ExecutionContext,
    waitUntil,
  };
}

describe('Worker friendship synchronization routes', () => {
  let firebaseWrites: Array<{ body: unknown; method: string }>;

  beforeEach(() => {
    firebaseWrites = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: URL, init: RequestInit) => {
        firebaseWrites.push({ body: JSON.parse(init.body as string), method: init.method ?? '' });
        return Promise.resolve(new Response(null, { status: 200 }));
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers presence-friends without loading the whole friendship graph', async () => {
    const queries: RecordedQuery[] = [];
    const { context, waitUntil } = createContext();
    const response = await worker.fetch(
      apiRequest('/api/presence-friends'),
      createEnvironment(queries),
      context,
    );

    expect(response.status).toBe(200);
    expect(waitUntil).toHaveBeenCalledOnce();

    await waitUntil.mock.calls[0]?.[0];

    expect(
      queries.some(({ query }) => query.includes(fullGraphMarker) && !query.includes('json_each')),
    ).toBe(false);
    expect(queries.find(({ query }) => query.includes('json_each'))?.values).toEqual([
      JSON.stringify(['alice-uid']),
    ]);
    expect(firebaseWrites).toEqual([
      { body: { 'alice-uid': { 'bob-uid': true } }, method: 'PATCH' },
    ]);
  });

  it('synchronizes only the affected friendship nodes after removing a friend', async () => {
    const queries: RecordedQuery[] = [];
    const { context } = createContext();
    const response = await worker.fetch(
      apiRequest('/api/friends/bob-uid', 'DELETE'),
      createEnvironment(queries),
      context,
    );

    expect(response.status).toBe(200);
    expect(queries.find(({ query }) => query.includes('json_each'))?.values).toEqual([
      JSON.stringify(['alice-uid', 'bob-uid']),
    ]);
    expect(firebaseWrites[0]?.method).toBe('PATCH');
  });

  it('rejects requests without a valid Firebase identity', async () => {
    const { context } = createContext();
    const request = new Request('https://api.example.test/api/presence-friends', {
      headers: { Origin: 'chrome-extension://allowed' },
    });
    const response = await worker.fetch(request, createEnvironment([]), context);

    expect(response.status).toBe(401);
    expect(firebaseWrites).toEqual([]);
  });

  it('binds affected users as one JSON parameter to stay under D1 limits', async () => {
    const queries: RecordedQuery[] = [];
    const uids = Array.from({ length: 150 }, (_, index) => `user-${index}`);

    await listFriendshipEdgesForUids(createDatabase(queries), [...uids, '', 'user-1']);

    expect(queries).toHaveLength(1);
    expect(queries[0]?.values).toEqual([JSON.stringify(uids)]);
  });
});
