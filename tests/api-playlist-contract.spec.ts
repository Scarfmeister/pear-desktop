import { test, expect } from '@playwright/test';
import { sign } from 'hono/jwt';

import { AuthStrategy } from '../src/plugins/api-server/config';
import { playlistChannels } from '../src/plugins/api-server/playlist-contract';
import {
  browse,
  deferred,
  fixture,
  ID,
  normal,
  shuffle,
  tick,
} from './api-playlist-fixtures';

test('strict JSON request validation produces safe 400s before any renderer work', async () => {
  const f = fixture();
  try {
    for (const body of [
      null,
      [],
      1,
      {},
      { playlistId: ID },
      { shuffle: false },
      { playlistId: ID, shuffle: 'false' },
      { playlistId: '', shuffle: true },
      { playlistId: ' ' + ID, shuffle: false },
      { playlistId: 'x'.repeat(257), shuffle: false },
      {
        playlistId: 'https://music.youtube.com/playlist?list=' + ID,
        shuffle: false,
      },
      { playlistId: ID, shuffle: true, extra: 'private-data' },
    ]) {
      const response = await f.request(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: 'INVALID_PLAYLIST_REQUEST', dispatch: 'not_dispatched' },
      });
    }
    for (const [contentType, body] of [
      ['text/plain', JSON.stringify({ playlistId: ID, shuffle: false })],
      ['application/json', '{broken'],
      ['application/json', ''],
    ]) {
      const response = await f.app.request('/api/v1/play-playlist', {
        method: 'POST',
        headers: { 'content-type': contentType },
        body,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: 'INVALID_PLAYLIST_REQUEST', dispatch: 'not_dispatched' },
      });
    }
    expect(f.window.webContents.sent).toEqual([]);
  } finally {
    f.dispose();
  }
});

for (const mode of [false, true])
  test(`authenticated native ${mode ? 'shuffle' : 'normal'} dispatch returns matching 200 after acknowledgment`, async () => {
    const f = fixture(AuthStrategy.AUTH_AT_FIRST);
    f.adapter.start();
    try {
      const token = await sign(
        { id: 'test-client', iat: 1 },
        f.getConfig().secret,
        'HS256',
      );
      const response = await f.request(
        { playlistId: ID, shuffle: mode },
        { authorization: `Bearer ${token}` },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        playlistId: ID,
        shuffle: mode,
        status: 'dispatched',
      });
      expect(f.fetches).toEqual([
        { path: '/browse', body: { browseId: `VL${ID}` } },
      ]);
      expect(f.nativeEvents).toHaveLength(1);
      expect(f.nativeEvents[0].args).toEqual([
        mode ? shuffle : normal,
        f.nativeApp,
      ]);
      expect(f.nativeEvents[0].optionalAction).toBe(false);
      expect(
        f.window.webContents.sent.filter(
          (item) => item.channel !== playlistChannels.start,
        ),
      ).toEqual([]);
    } finally {
      f.dispose();
    }
  });

test('existing JWT/authorized-client guards deny before validation or browse; NONE is supported', async () => {
  const f = fixture(AuthStrategy.AUTH_AT_FIRST);
  f.adapter.start();
  try {
    const other = await sign(
      { id: 'not-authorized', iat: 1 },
      f.getConfig().secret,
      'HS256',
    );
    for (const headers of [
      {},
      { authorization: 'Bearer invalid-private-token' },
      { authorization: `Bearer ${other}` },
    ] as Record<string, string>[]) {
      const response = await f.request({ extra: 'malformed' }, headers);
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain('invalid-private-token');
    }
    expect(f.fetches).toEqual([]);
    expect(f.window.webContents.sent).toEqual([]);
    f.setConfig({ authStrategy: AuthStrategy.NONE });
    expect((await f.request()).status).toBe(200);
  } finally {
    f.dispose();
  }
});

test('authorization revocation, secret/strategy changes, and disable are rechecked before permit', async () => {
  for (const change of [
    { authorizedClients: [] },
    { secret: 'changed-secret' },
    { authStrategy: AuthStrategy.NONE },
    { enabled: false },
  ]) {
    const f = fixture(AuthStrategy.AUTH_AT_FIRST);
    const pending = deferred<unknown>();
    f.setResponse(() => pending.promise);
    f.adapter.start();
    try {
      const token = await sign(
        { id: 'test-client', iat: 1 },
        f.getConfig().secret,
        'HS256',
      );
      const response = f.request(undefined, {
        authorization: `Bearer ${token}`,
      });
      await expect.poll(() => f.fetches.length).toBe(1);
      f.setConfig(change);
      pending.resolve(browse());
      expect((await response).status).toBe('enabled' in change ? 503 : 401);
      expect(f.nativeEvents).toEqual([]);
    } finally {
      f.dispose();
    }
  }
});

test('one in-flight request rejects overlap without queuing; only native acknowledgment completes success', async () => {
  const f = fixture();
  const pending = deferred<unknown>();
  f.setResponse(() => pending.promise);
  f.adapter.start();
  try {
    const first = f.request();
    await tick();
    const second = await f.request({ playlistId: ID, shuffle: true });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      error: { code: 'PLAYLIST_START_BUSY', dispatch: 'not_dispatched' },
    });
    expect(f.fetches).toHaveLength(1);
    expect(f.nativeEvents).toHaveLength(0);
    pending.resolve(browse());
    expect((await first).status).toBe(200);
    expect(f.nativeEvents).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

test('HTTP abort cancels resolution and cannot turn a late browse response into playback', async () => {
  const f = fixture();
  const pending = deferred<unknown>();
  f.setResponse(() => pending.promise);
  f.adapter.start();
  const abort = new AbortController();
  try {
    const response = f.request(undefined, {}, abort.signal);
    await tick();
    abort.abort();
    const result = await response;
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({
      error: { code: 'PLAYER_NOT_READY', dispatch: 'not_dispatched' },
    });
    pending.resolve(browse());
    await tick();
    expect(f.nativeEvents).toEqual([]);
    expect(await f.permit(f.last())).toEqual({ allowed: false });
  } finally {
    f.dispose();
  }
});

test('safe errors distinguish unavailable, unsupported, resolution failure, missing handler, and readiness', async () => {
  for (const [response, code, status] of [
    [
      () =>
        Promise.resolve({
          alerts: [
            { alertRenderer: { type: 'ERROR', text: 'private-account-data' } },
          ],
        }),
      'PLAYLIST_UNAVAILABLE',
      422,
    ],
    [
      () => Promise.resolve({ contents: {} }),
      'NATIVE_PLAYLIST_CONTROL_UNAVAILABLE',
      501,
    ],
    [
      () => Promise.reject(new Error('private-response-token')),
      'PLAYLIST_RESOLUTION_FAILED',
      502,
    ],
  ] as const) {
    const f = fixture();
    f.setResponse(response);
    f.adapter.start();
    try {
      const result = await f.request();
      expect(result.status).toBe(status);
      expect(await result.json()).toEqual({
        error: { code, dispatch: 'not_dispatched' },
      });
      expect(f.nativeEvents).toEqual([]);
    } finally {
      f.dispose();
    }
  }
  const f = fixture();
  f.adapter.start();
  try {
    f.setAck(false);
    const missing = await f.request();
    expect(missing.status).toBe(501);
    expect(await missing.json()).toEqual({
      error: {
        code: 'NATIVE_PLAYLIST_DISPATCH_UNAVAILABLE',
        dispatch: 'not_dispatched',
      },
    });
    f.setReady(false);
    expect((await f.request()).status).toBe(503);
    expect(f.fetches).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

test('OpenAPI documents strict inputs, auth, dispatch-only success, and all error statuses', async () => {
  const f = fixture();
  try {
    const doc = (await (await f.app.request('/doc')).json()) as {
      paths: Record<
        string,
        {
          post: {
            responses: Record<string, unknown>;
            security: unknown;
            requestBody: unknown;
          };
        }
      >;
      components: {
        schemas: Record<string, { additionalProperties?: boolean }>;
      };
    };
    const route = doc.paths['/api/v1/play-playlist'].post;
    expect(Object.keys(route.responses)).toEqual([
      '200',
      '400',
      '401',
      '409',
      '422',
      '501',
      '502',
      '503',
      '504',
    ]);
    expect(route.security).toEqual([{ bearerAuth: [] }]);
    expect(
      doc.components.schemas.PlaylistStartRequest.additionalProperties,
    ).toBe(false);
  } finally {
    f.dispose();
  }
});
