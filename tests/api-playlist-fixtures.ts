import { EventEmitter } from 'node:events';

import { OpenAPIHono } from '@hono/zod-openapi';
import { jwt } from 'hono/jwt';

import {
  AuthStrategy,
  defaultAPIServerConfig,
} from '../src/plugins/api-server/config';
import { PlaylistBroker } from '../src/plugins/api-server/backend/playlist-broker';
import { register } from '../src/plugins/api-server/backend/routes/playlist';
import { playlistChannels } from '../src/plugins/api-server/playlist-contract';
import { PlaylistAdapter } from '../src/plugins/api-server/renderer/playlist-adapter';

import type { APIServerConfig } from '../src/plugins/api-server/config';
import type { PlaylistApp } from '../src/plugins/api-server/renderer/playlist-command';
import type { BackendContext, RendererContext } from '../src/types/contexts';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';

export const ID = 'PL_requested';
export const normal = {
  clickTrackingParams: 'fixture-normal-tracking',
  watchEndpoint: {
    videoId: 'first-video',
    playlistId: ID,
    params: 'fixture-normal-opaque',
    loggingContext: {
      vssLoggingContext: { serializedContextData: 'fixture-context' },
    },
    watchEndpointMusicSupportedConfigs: {
      watchEndpointMusicConfig: { musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' },
    },
  },
};
export const shuffle = {
  clickTrackingParams: 'fixture-shuffle-tracking',
  watchPlaylistEndpoint: {
    playlistId: ID,
    params: 'fixture-native-shuffle-opaque',
  },
};
export const state = (shuffleEnabled = false, playlistId?: string) => ({
  queue: {
    shuffleEnabled,
    items: playlistId
      ? [
          {
            playlistPanelVideoRenderer: {
              navigationEndpoint: {
                watchEndpoint: { playlistId, videoId: 'current-video' },
              },
            },
          },
        ]
      : [],
  },
  entities: { commandEntity: {} as Record<string, unknown> },
});
export const responsiveHeader = () => ({
  buttons: [
    {
      musicPlayButtonRenderer: {
        playNavigationEndpoint: structuredClone(normal),
      },
    },
    {
      menuRenderer: {
        items: [
          {
            menuNavigationItemRenderer: {
              icon: { iconType: 'MUSIC_SHUFFLE' },
              text: { simpleText: 'localized label' },
              navigationEndpoint: structuredClone(shuffle),
            },
          },
          {
            menuNavigationItemRenderer: {
              icon: { iconType: 'MIX' },
              navigationEndpoint: {
                watchPlaylistEndpoint: { playlistId: 'RD_wrong_mix' },
              },
            },
          },
          {
            menuServiceItemRenderer: {
              icon: { iconType: 'QUEUE_PLAY_NEXT' },
              serviceEndpoint: { queueAddEndpoint: { playlistId: ID } },
            },
          },
        ],
      },
    },
  ],
});
export const browse = (header: unknown = responsiveHeader()) => ({
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            selected: true,
            content: {
              sectionListRenderer: {
                contents: [
                  { musicResponsiveHeaderRenderer: header },
                  {
                    musicShelfRenderer: {
                      contents: [
                        {
                          musicResponsiveListItemRenderer: {
                            navigationEndpoint: {
                              watchPlaylistEndpoint: {
                                playlistId: 'RD_related',
                              },
                            },
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    },
  },
});

export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

class FakeIpc extends EventEmitter {
  handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, value: unknown) => unknown
  >();
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, value: unknown) => unknown,
  ) {
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string) {
    this.handlers.delete(channel);
  }
}
class FakeContents extends EventEmitter {
  mainFrame = {};
  destroyed = false;
  sent: { channel: string; value: unknown }[] = [];
  onSend?: (channel: string, value: unknown) => void;
  isDestroyed() {
    return this.destroyed;
  }
  send(channel: string, value: unknown) {
    this.sent.push({ channel, value });
    this.onSend?.(channel, value);
  }
}
class FakeWindow extends EventEmitter {
  webContents = new FakeContents();
  destroyed = false;
  isDestroyed() {
    return this.destroyed;
  }
}

export const fixture = (strategy = AuthStrategy.NONE) => {
  const ipc = new FakeIpc();
  const window = new FakeWindow();
  let config: APIServerConfig = {
    ...defaultAPIServerConfig,
    enabled: true,
    authStrategy: strategy,
    secret: 'fixture-secret-for-tests-only',
    authorizedClients: ['test-client'],
  };
  let now = Date.now();
  let getConfig = () => Promise.resolve(config);
  const broker = new PlaylistBroker(
    window as unknown as BrowserWindow,
    ipc as unknown as IpcMain,
    () => getConfig(),
    () => now,
  );
  broker.resume();
  const sender = () =>
    ({
      sender: window.webContents,
      senderFrame: window.webContents.mainFrame,
    }) as unknown as IpcMainInvokeEvent;
  const permit = (value: unknown, event = sender()) =>
    Promise.resolve(ipc.handlers.get(playlistChannels.permit)?.(event, value));
  const result = (value: unknown, event = sender()) =>
    ipc.emit(playlistChannels.result, event, value);
  const controller = new AbortController();
  const start = (id = ID, shuffled = false) =>
    broker.start(
      { playlistId: id, shuffle: shuffled },
      () => true,
      controller.signal,
    );
  const last = () =>
    window.webContents.sent
      .filter((message) => message.channel === playlistChannels.start)
      .at(-1)!.value as {
      requestId: string;
      generation: string;
      deadlineUnixMs: number;
      playlistId: string;
      shuffle: boolean;
    };
  const app = new OpenAPIHono();
  // Match the existing main.ts JWT/authorized-client guards, before route parsing.
  app.use('/api/*', async (ctx, next) =>
    config.authStrategy === AuthStrategy.NONE
      ? next()
      : jwt({ secret: config.secret, alg: 'HS256' })(ctx, next),
  );
  app.use('/api/*', async (ctx, next) => {
    const payload = ctx.get('jwtPayload') as { id?: string } | undefined;
    if (
      config.authStrategy !== AuthStrategy.NONE &&
      !config.authorizedClients.includes(payload?.id ?? '')
    )
      return ctx.body('Unauthorized', 401);
    await next();
    return undefined;
  });
  register(
    app,
    { getConfig: () => config } as BackendContext<APIServerConfig>,
    broker,
  );
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
  });
  app.doc('/doc', {
    openapi: '3.1.0',
    info: { title: 'Test API', version: '1' },
  });
  const request = (
    body: unknown = { playlistId: ID, shuffle: false },
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ) =>
    app.request('/api/v1/play-playlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });

  const rendererListeners = new Map<string, (value: unknown) => unknown>();
  const rendererIpc = {
    on: (channel: string, listener: (value: unknown) => unknown) =>
      rendererListeners.set(channel, listener),
    removeAllListeners: (channel: string) => rendererListeners.delete(channel),
    send: (channel: string, value: unknown) =>
      ipc.emit(channel, sender(), value),
    invoke: (_channel: string, value: unknown) => permit(value),
  } as unknown as RendererContext<APIServerConfig>['ipc'];
  window.webContents.onSend = (channel, value) => {
    rendererListeners.get(channel)?.(value);
  };
  let ready = true;
  let connected = true;
  let nativeState: unknown = state();
  let response = () => Promise.resolve<unknown>(browse());
  const fetches: { path: string; body: unknown }[] = [];
  const nativeEvents: {
    actionName: string;
    optionalAction: boolean;
    args: unknown[];
    returnValue: unknown[];
  }[] = [];
  let ack = true;
  const target = new EventTarget();
  const nativeApp = Object.assign(target, {
    get isConnected() {
      return connected;
    },
    networkManager: {
      fetch: (path: string, body: unknown) => {
        fetches.push({ path, body });
        return response();
      },
    },
  }) as unknown as PlaylistApp;
  // Object.assign invokes getters, so use a real dynamic property for teardown tests.
  Object.defineProperty(nativeApp, 'isConnected', { get: () => connected });
  nativeApp.addEventListener('yt-action', (event) => {
    const detail = (event as CustomEvent<(typeof nativeEvents)[number]>).detail;
    nativeEvents.push(detail);
    if (ack) detail.returnValue.push(undefined);
  });
  const adapter = new PlaylistAdapter(
    rendererIpc,
    () => nativeApp,
    () => ready,
    () => nativeState,
    () => now,
  );
  return {
    ipc,
    window,
    broker,
    sender,
    permit,
    result,
    controller,
    start,
    last,
    app,
    request,
    adapter,
    rendererIpc,
    rendererListeners,
    nativeApp,
    fetches,
    nativeEvents,
    setNow: (value: number) => {
      now = value;
    },
    setConfig: (value: Partial<APIServerConfig>) => {
      config = { ...config, ...value };
    },
    getConfig: () => config,
    setConfigReader: (read: typeof getConfig) => {
      getConfig = read;
    },
    setResponse: (read: typeof response) => {
      response = read;
    },
    setState: (value: unknown) => {
      nativeState = value;
    },
    setReady: (value: boolean) => {
      ready = value;
    },
    setConnected: (value: boolean) => {
      connected = value;
    },
    setAck: (value: boolean) => {
      ack = value;
    },
    dispose: () => {
      adapter.stop();
      broker.dispose();
    },
  };
};
