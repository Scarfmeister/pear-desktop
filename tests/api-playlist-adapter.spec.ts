import { test, expect } from '@playwright/test';

import { playlistChannels } from '../src/plugins/api-server/playlist-contract';
import {
  browse,
  deferred,
  fixture,
  ID,
  state,
  tick,
} from './api-playlist-fixtures';

test('renderer start/stop/re-enable restores readiness without duplicate listeners or independent state', async () => {
  const f = fixture();
  try {
    f.adapter.start();
    f.adapter.start();
    expect(f.rendererListeners.size).toBe(2);
    f.setReady(false);
    expect((await f.request()).status).toBe(503);
    expect(f.fetches).toEqual([]);
    f.setReady(true);
    expect((await f.request()).status).toBe(200);
    f.adapter.stop();
    expect(f.rendererListeners.size).toBe(0);
    f.broker.suspend();
    f.broker.resume();
    f.adapter.start();
    expect((await f.request({ playlistId: ID, shuffle: true })).status).toBe(
      200,
    );
    expect(f.nativeEvents).toHaveLength(2);
  } finally {
    f.dispose();
  }
});

test('duplicate start and cancellation correlation cannot produce a second dispatch', async () => {
  const f = fixture();
  const response = deferred<unknown>();
  f.setResponse(() => response.promise);
  f.adapter.start();
  try {
    const pending = f.request();
    await tick();
    const request = f.last();
    f.rendererListeners.get(playlistChannels.start)?.(request);
    f.rendererListeners.get(playlistChannels.cancel)?.({
      ...request,
      requestId: 'wrong',
    });
    expect(f.fetches).toHaveLength(1);
    response.resolve(browse());
    expect((await pending).status).toBe(200);
    f.rendererListeners.get(playlistChannels.start)?.(request);
    await tick();
    expect(f.fetches).toHaveLength(1);
    expect(f.nativeEvents).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

test('renderer teardown, lost readiness, disconnection and absolute expiry stop late resolution before permit', async () => {
  for (const change of ['stop', 'ready', 'connected', 'deadline']) {
    const f = fixture();
    const response = deferred<unknown>();
    f.setResponse(() => response.promise);
    f.adapter.start();
    try {
      const pending = f.request();
      await tick();
      if (change === 'stop') {
        f.broker.suspend();
        f.adapter.stop();
      }
      if (change === 'ready') f.setReady(false);
      if (change === 'connected') f.setConnected(false);
      if (change === 'deadline') f.setNow(f.last().deadlineUnixMs);
      response.resolve(browse());
      const result = await pending;
      expect(result.status).toBe(change === 'deadline' ? 504 : 503);
      expect(f.nativeEvents).toEqual([]);
    } finally {
      f.dispose();
    }
  }
});

test('queue and cancellation are checked again after permit; no await or workaround follows the final guard', async () => {
  for (const change of ['queue', 'abort', 'ready', 'deadline']) {
    const f = fixture();
    f.adapter.start();
    const invoke = f.rendererIpc.invoke;
    f.rendererIpc.invoke = async (channel, value: unknown) => {
      const allowed: unknown = await invoke(channel, value);
      if (change === 'queue') f.setState(state(true, ID));
      if (change === 'abort') f.broker.reset();
      if (change === 'ready') f.setReady(false);
      if (change === 'deadline') f.setNow(f.last().deadlineUnixMs);
      return allowed;
    };
    try {
      const result = await f.request();
      expect(result.status).toBe(
        change === 'queue' ? 501 : change === 'deadline' ? 504 : 503,
      );
      expect(f.nativeEvents).toEqual([]);
      const body = (await result.json()) as { error: { dispatch: string } };
      expect(body.error.dispatch).toBe(
        change === 'queue' ? 'not_dispatched' : 'unknown',
      );
    } finally {
      f.dispose();
    }
  }
});

test('native event envelope preserves source, complete command, bubbles/composed flags, and undefined acknowledgment', async () => {
  const f = fixture();
  f.adapter.start();
  let flags: unknown;
  f.nativeApp.addEventListener('yt-action', (event) => {
    flags = [event.bubbles, event.composed, event.type];
  });
  try {
    const result = await f.request();
    expect(result.status).toBe(200);
    expect(flags).toEqual([true, true, 'yt-action']);
    expect(f.nativeEvents[0].returnValue).toEqual([undefined]);
    expect(f.nativeEvents[0].args[1]).toBe(f.nativeApp);
  } finally {
    f.dispose();
  }
});

test('an unexpected dispatch failure after permit is unknown, safe, and not retried', async () => {
  const f = fixture();
  f.adapter.start();
  f.nativeApp.dispatchEvent = () => {
    throw new Error('private-native-account-detail');
  };
  try {
    const result = await f.request();
    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({
      error: { code: 'PLAYLIST_DISPATCH_FAILED', dispatch: 'unknown' },
    });
    expect(f.fetches).toHaveLength(1);
    expect(
      f.window.webContents.sent.filter(
        (item) => item.channel === playlistChannels.start,
      ),
    ).toHaveLength(1);
  } finally {
    f.dispose();
  }
});
