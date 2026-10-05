import { randomUUID } from 'node:crypto';

import {
  isCorrelation,
  isPlaylistResult,
  playlistChannels,
  playlistErrorStatus,
  playlistFailure,
  PLAYLIST_START_TIMEOUT_MS,
  type PlaylistDispatch,
  type PlaylistError,
  type PlaylistErrorCode,
  type PlaylistErrorStatus,
  type PlaylistRequest,
  type PlaylistStart,
} from '../playlist-contract';

import type { APIServerConfig } from '../config';
import type {
  BrowserWindow,
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
} from 'electron';

export type PlaylistResponse =
  | { status: 200; body: PlaylistDispatch }
  | { status: PlaylistErrorStatus; body: PlaylistError }
  | { status: 401 };

type Pending = {
  start: PlaylistStart;
  authorize: (config: APIServerConfig) => boolean;
  resolve: (value: PlaylistResponse) => void;
  timer: ReturnType<typeof setTimeout>;
  signal: AbortSignal;
  abort: () => void;
  permitted: boolean;
};

/** One bounded native startup. Nothing is queued or replayed. */
export class PlaylistBroker {
  private generation = randomUUID();
  private enabled = false;
  private disposed = false;
  private pending?: Pending;

  constructor(
    private readonly window: BrowserWindow,
    private readonly ipc: Pick<
      IpcMain,
      'on' | 'removeListener' | 'handle' | 'removeHandler'
    >,
    private readonly getConfig: () =>
      | APIServerConfig
      | Promise<APIServerConfig>,
    private readonly now = Date.now,
  ) {
    ipc.on(playlistChannels.result, this.onResult);
    ipc.handle(playlistChannels.permit, this.onPermit);
    window.webContents.on('did-start-navigation', this.onNavigation);
    window.webContents.on('render-process-gone', this.onUnavailable);
    window.webContents.on('destroyed', this.onUnavailable);
    window.on('closed', this.onUnavailable);
  }

  resume() {
    if (this.disposed) return;
    this.reset();
    this.enabled = true;
  }

  suspend() {
    this.enabled = false;
    this.reset();
  }

  reset() {
    this.cancel('PLAYER_NOT_READY');
    this.generation = randomUUID();
  }

  dispose() {
    if (this.disposed) return;
    this.suspend();
    this.disposed = true;
    this.ipc.removeListener(playlistChannels.result, this.onResult);
    this.ipc.removeHandler(playlistChannels.permit);
    this.window.webContents.removeListener(
      'did-start-navigation',
      this.onNavigation,
    );
    this.window.webContents.removeListener(
      'render-process-gone',
      this.onUnavailable,
    );
    this.window.webContents.removeListener('destroyed', this.onUnavailable);
    this.window.removeListener('closed', this.onUnavailable);
  }

  start(
    request: PlaylistRequest,
    authorize: Pending['authorize'],
    signal: AbortSignal,
  ): Promise<PlaylistResponse> {
    if (!this.available() || signal.aborted) {
      return Promise.resolve(this.failure('PLAYER_NOT_READY'));
    }
    if (this.pending) {
      return Promise.resolve(this.failure('PLAYLIST_START_BUSY'));
    }

    return new Promise((resolve) => {
      const start: PlaylistStart = {
        ...request,
        requestId: randomUUID(),
        generation: this.generation,
        deadlineUnixMs: this.now() + PLAYLIST_START_TIMEOUT_MS,
      };
      const pending: Pending = {
        start,
        authorize,
        resolve,
        permitted: false,
        timer: setTimeout(
          () => this.cancel('PLAYLIST_START_TIMEOUT'),
          PLAYLIST_START_TIMEOUT_MS,
        ),
        signal,
        abort: () => {
          if (this.pending === pending) this.cancel('PLAYER_NOT_READY');
        },
      };
      this.pending = pending;
      signal.addEventListener('abort', pending.abort, { once: true });
      try {
        this.window.webContents.send(playlistChannels.start, start);
      } catch {
        this.cancel('PLAYER_NOT_READY');
      }
    });
  }

  private available() {
    return (
      this.enabled &&
      !this.disposed &&
      !this.window.isDestroyed() &&
      !this.window.webContents.isDestroyed()
    );
  }

  private owns(event: IpcMainEvent | IpcMainInvokeEvent) {
    return (
      this.available() &&
      event.sender === this.window.webContents &&
      event.senderFrame != null &&
      event.senderFrame === this.window.webContents.mainFrame
    );
  }

  private matches(value: unknown) {
    return (
      isCorrelation(value) &&
      this.pending?.start.requestId === value.requestId &&
      this.pending.start.generation === value.generation
    );
  }

  private readonly onPermit = async (
    event: IpcMainInvokeEvent,
    value: unknown,
  ): Promise<{ allowed: boolean }> => {
    if (!this.owns(event) || !this.matches(value)) return { allowed: false };
    const pending = this.pending!;
    if (pending.permitted) return { allowed: false };
    if (this.now() >= pending.start.deadlineUnixMs) {
      this.cancel('PLAYLIST_START_TIMEOUT');
      return { allowed: false };
    }

    let config: APIServerConfig;
    try {
      config = await this.getConfig();
    } catch {
      if (this.pending === pending) this.cancel('PLAYER_NOT_READY');
      return { allowed: false };
    }
    // Config reads can yield while HTTP abort, reload, or stop cancels the request.
    if (!this.owns(event) || this.pending !== pending || pending.permitted) {
      return { allowed: false };
    }
    if (this.now() >= pending.start.deadlineUnixMs) {
      this.cancel('PLAYLIST_START_TIMEOUT');
      return { allowed: false };
    }
    if (!config.enabled) {
      this.cancel('PLAYER_NOT_READY');
      return { allowed: false };
    }
    if (!pending.authorize(config)) {
      this.finish({ status: 401 }, true);
      return { allowed: false };
    }
    pending.permitted = true;
    return { allowed: true };
  };

  private readonly onResult = (event: IpcMainEvent, value: unknown) => {
    if (!this.owns(event) || !isPlaylistResult(value) || !this.matches(value)) {
      return;
    }
    const pending = this.pending!;
    if (this.now() >= pending.start.deadlineUnixMs) {
      this.cancel('PLAYLIST_START_TIMEOUT');
    } else if (value.status === 'dispatched') {
      if (!pending.permitted) return;
      const { playlistId, shuffle } = pending.start;
      this.finish({
        status: 200,
        body: { playlistId, shuffle, status: 'dispatched' },
      });
    } else {
      // These failures positively establish that no native startup was emitted.
      const notDispatched =
        value.code === 'NATIVE_PLAYLIST_CONTROL_UNAVAILABLE' ||
        value.code === 'NATIVE_PLAYLIST_DISPATCH_UNAVAILABLE';
      this.finish(
        this.failure(value.code, pending.permitted && !notDispatched),
      );
    }
  };

  private readonly onNavigation = (
    _event: unknown,
    _url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame && !isInPlace) this.reset();
  };

  private readonly onUnavailable = () => this.reset();

  private failure(code: PlaylistErrorCode, unknown = false): PlaylistResponse {
    return {
      status: playlistErrorStatus[code],
      body: playlistFailure(code, unknown ? 'unknown' : 'not_dispatched'),
    };
  }

  private cancel(code: PlaylistErrorCode) {
    if (this.pending) {
      this.finish(this.failure(code, this.pending.permitted), true);
    }
  }

  private finish(response: PlaylistResponse, cancel = false) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.signal.removeEventListener('abort', pending.abort);
    if (cancel && !this.window.webContents.isDestroyed()) {
      try {
        this.window.webContents.send(playlistChannels.cancel, {
          requestId: pending.start.requestId,
          generation: pending.start.generation,
        });
      } catch {
        // A destroyed renderer cannot accept a cancellation message.
      }
    }
    pending.resolve(response);
  }
}
