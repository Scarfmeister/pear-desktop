import { test, expect } from '@playwright/test';

import { playlistChannels } from '../src/plugins/api-server/playlist-contract';
import { deferred, fixture, ID, tick } from './api-playlist-fixtures';

import type { IpcMainInvokeEvent } from 'electron';

test('wrong sender/frame/correlation, unpermitted success, malformed and stale results cannot dispatch or complete', async () => {
  const f = fixture();
  try {
    const pending = f.start();
    const request = f.last();
    const wrongWindow = {
      sender: {},
      senderFrame: f.window.webContents.mainFrame,
    } as unknown as IpcMainInvokeEvent;
    const wrongFrame = {
      sender: f.window.webContents,
      senderFrame: {},
    } as unknown as IpcMainInvokeEvent;
    const noFrame = {
      sender: f.window.webContents,
      senderFrame: null,
    } as unknown as IpcMainInvokeEvent;
    for (const sender of [wrongWindow, wrongFrame, noFrame]) {
      expect(await f.permit(request, sender)).toEqual({ allowed: false });
      f.result({ ...request, status: 'dispatched' }, sender);
    }
    for (const data of [
      { ...request, requestId: 'old' },
      { ...request, generation: 'old' },
      {},
      null,
    ]) {
      expect(await f.permit(data)).toEqual({ allowed: false });
      f.result({ ...data, status: 'dispatched' });
    }
    f.result({ ...request, status: 'dispatched' });
    f.result({ ...request, status: 'failed', code: 'PRIVATE_TOKEN' });
    expect((await f.start()).status).toBe(409);
    expect(await f.permit(request)).toEqual({ allowed: true });
    expect(await f.permit(request)).toEqual({ allowed: false });
    f.result({ ...request, status: 'dispatched' });
    expect(await pending).toEqual({
      status: 200,
      body: { playlistId: ID, shuffle: false, status: 'dispatched' },
    });
    f.result({
      ...request,
      status: 'failed',
      code: 'PLAYLIST_DISPATCH_FAILED',
    });
    const next = f.start(ID, true);
    const second = f.last();
    f.result({ ...request, status: 'dispatched' });
    expect(await f.permit(second)).toEqual({ allowed: true });
    f.result({ ...second, status: 'dispatched' });
    expect((await next).status).toBe(200);
  } finally {
    f.dispose();
  }
});

for (const permitted of [false, true])
  test(`deadline expiry ${permitted ? 'after' : 'before'} permit preserves dispatch uncertainty and sends cancel`, async () => {
    const f = fixture();
    try {
      const pending = f.start();
      const request = f.last();
      if (permitted) expect(await f.permit(request)).toEqual({ allowed: true });
      f.setNow(request.deadlineUnixMs);
      expect(await f.permit(request)).toEqual({ allowed: false });
      // A duplicate permit is denied without changing the timer; a late result still expires.
      f.result({ ...request, status: 'dispatched' });
      const response = await pending;
      expect(response).toEqual({
        status: 504,
        body: {
          error: {
            code: 'PLAYLIST_START_TIMEOUT',
            dispatch: permitted ? 'unknown' : 'not_dispatched',
          },
        },
      });
      expect(f.window.webContents.sent.at(-1)?.channel).toBe(
        playlistChannels.cancel,
      );
      expect(await f.permit(request)).toEqual({ allowed: false });
    } finally {
      f.dispose();
    }
  });

test('the real five-second server timer completes a silent renderer without replay', async () => {
  const f = fixture();
  try {
    const pending = f.start();
    const request = f.last();
    expect(request.deadlineUnixMs).toBeGreaterThan(Date.now());
    expect(await pending).toEqual({
      status: 504,
      body: {
        error: { code: 'PLAYLIST_START_TIMEOUT', dispatch: 'not_dispatched' },
      },
    });
    expect(f.window.webContents.sent.map((item) => item.channel)).toEqual([
      playlistChannels.start,
      playlistChannels.cancel,
    ]);
  } finally {
    f.dispose();
  }
});

for (const permitted of [false, true])
  test(`abort ${permitted ? 'after' : 'before'} permit is canceled and never replayed`, async () => {
    const f = fixture();
    try {
      const pending = f.start();
      const request = f.last();
      if (permitted) await f.permit(request);
      f.controller.abort();
      expect(await pending).toEqual({
        status: 503,
        body: {
          error: {
            code: 'PLAYER_NOT_READY',
            dispatch: permitted ? 'unknown' : 'not_dispatched',
          },
        },
      });
      f.result({ ...request, status: 'dispatched' });
      expect(await f.permit(request)).toEqual({ allowed: false });
    } finally {
      f.dispose();
    }
  });

test('stop/re-enable, API rebind/config reset, main-frame reload, renderer loss and destruction cancel old generations', async () => {
  for (const trigger of [
    'stop',
    'reset',
    'reload',
    'crash',
    'destroy',
    'closed',
  ]) {
    const f = fixture();
    try {
      const pending = f.start();
      const old = f.last();
      if (trigger === 'stop') f.broker.suspend();
      if (trigger === 'reset') f.broker.reset();
      if (trigger === 'reload')
        f.window.webContents.emit(
          'did-start-navigation',
          {},
          'https://music.youtube.com/',
          false,
          true,
        );
      if (trigger === 'crash')
        f.window.webContents.emit('render-process-gone', {}, {});
      if (trigger === 'destroy') {
        f.window.webContents.destroyed = true;
        f.window.webContents.emit('destroyed');
      }
      if (trigger === 'closed') {
        f.window.destroyed = true;
        f.window.emit('closed');
      }
      expect((await pending).status).toBe(503);
      expect(await f.permit(old)).toEqual({ allowed: false });
      f.broker.resume();
      if (trigger !== 'destroy' && trigger !== 'closed') {
        const next = f.start();
        const current = f.last();
        expect(current.generation).not.toBe(old.generation);
        f.result({ ...old, status: 'dispatched' });
        await f.permit(current);
        f.result({ ...current, status: 'dispatched' });
        expect((await next).status).toBe(200);
      } else expect((await f.start()).status).toBe(503);
    } finally {
      f.dispose();
    }
  }
});

test('SPA navigation and subframes do not invalidate a permitted main-frame request', async () => {
  const f = fixture();
  try {
    const pending = f.start();
    const request = f.last();
    f.window.webContents.emit(
      'did-start-navigation',
      {},
      'https://music.youtube.com/watch',
      true,
      true,
    );
    f.window.webContents.emit(
      'did-start-navigation',
      {},
      'https://other.test/',
      false,
      false,
    );
    expect(await f.permit(request)).toEqual({ allowed: true });
    f.result({ ...request, status: 'dispatched' });
    expect((await pending).status).toBe(200);
  } finally {
    f.dispose();
  }
});

test('a config read yielding during cancellation cannot grant a late permit', async () => {
  const f = fixture();
  const config = deferred<ReturnType<typeof f.getConfig>>();
  try {
    const pending = f.start();
    const request = f.last();
    f.setConfigReader(() => config.promise);
    const permit = f.permit(request);
    await tick();
    f.broker.reset();
    config.resolve(f.getConfig());
    expect(await permit).toEqual({ allowed: false });
    expect((await pending).status).toBe(503);
  } finally {
    f.dispose();
  }
});

test('disposal removes exact owned listeners and permit handler without removing other listeners', () => {
  const f = fixture();
  const other = () => {};
  f.ipc.on(playlistChannels.result, other);
  f.window.webContents.on('destroyed', other);
  f.broker.dispose();
  f.broker.dispose();
  expect(f.ipc.listeners(playlistChannels.result)).toEqual([other]);
  expect(f.ipc.handlers.has(playlistChannels.permit)).toBe(false);
  expect(f.window.webContents.listeners('destroyed')).toEqual([other]);
  expect(f.window.webContents.listenerCount('did-start-navigation')).toBe(0);
  expect(f.window.listenerCount('closed')).toBe(0);
  f.dispose();
});
