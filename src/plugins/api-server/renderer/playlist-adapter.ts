import {
  dispatchPlaylistCommand,
  guardNormalStartup,
  PlaylistCommandError,
  resolvePlaylistCommand,
  type PlaylistApp,
} from './playlist-command';

import {
  isCorrelation,
  isPlaylistStart,
  isRecord,
  playlistChannels,
  PLAYLIST_START_TIMEOUT_MS,
  type PlaylistErrorCode,
  type PlaylistStart,
} from '../playlist-contract';

import type { APIServerConfig } from '../config';
import type { RendererContext } from '@/types/contexts';

type Pending = { request: PlaylistStart; timer: ReturnType<typeof setTimeout> };

/** Plugin-owned renderer bridge; no independent playback or login state. */
export class PlaylistAdapter {
  private pending?: Pending;
  private readonly seen = new Set<string>();
  private enabled = false;

  constructor(
    private readonly ipc: RendererContext<APIServerConfig>['ipc'],
    private readonly getApp: () => PlaylistApp | null,
    private readonly isReady: () => boolean,
    private readonly getState: () => unknown,
    private readonly now = Date.now,
  ) {}

  start() {
    if (this.enabled) return;
    this.enabled = true;
    this.ipc.on(playlistChannels.start, this.onStart);
    this.ipc.on(playlistChannels.cancel, this.onCancel);
  }

  stop() {
    this.enabled = false;
    this.clear();
    this.ipc.removeAllListeners(playlistChannels.start);
    this.ipc.removeAllListeners(playlistChannels.cancel);
  }

  private clear() {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = undefined;
  }

  private readonly onCancel = (value: unknown) => {
    if (
      isCorrelation(value) &&
      value.requestId === this.pending?.request.requestId &&
      value.generation === this.pending.request.generation
    ) {
      this.clear();
    }
  };

  private readonly onStart = async (value: unknown) => {
    if (!this.enabled || !isPlaylistStart(value)) return;
    const key = `${value.generation}/${value.requestId}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 32) this.seen.delete(this.seen.values().next().value!);
    if (this.pending) {
      if (this.pending.request.generation === value.generation) {
        this.sendResult(value, 'PLAYLIST_START_BUSY');
        return;
      }
      this.clear();
    }
    const pending: Pending = {
      request: value,
      timer: setTimeout(
        () => {
          if (this.pending === pending) {
            this.sendResult(value, 'PLAYLIST_START_TIMEOUT');
            this.clear();
          }
        },
        Math.min(
          PLAYLIST_START_TIMEOUT_MS,
          Math.max(0, value.deadlineUnixMs - this.now()),
        ),
      ),
    };
    this.pending = pending;
    let permitted = false;
    try {
      const app = this.getApp();
      if (!app || !this.ready(pending, app)) {
        this.sendResult(
          value,
          this.now() >= value.deadlineUnixMs
            ? 'PLAYLIST_START_TIMEOUT'
            : 'PLAYER_NOT_READY',
        );
        return;
      }
      const response = await app.networkManager.fetch('/browse', {
        browseId: `VL${value.playlistId}`,
      });
      if (!this.ready(pending, app)) {
        this.reportUnavailable(pending);
        return;
      }
      const command = resolvePlaylistCommand(response, value, this.getState());
      const permit: unknown = await this.ipc.invoke(playlistChannels.permit, {
        requestId: value.requestId,
        generation: value.generation,
      });
      permitted = isRecord(permit) && permit.allowed === true;
      if (!permitted || !this.ready(pending, app)) {
        this.reportUnavailable(pending);
        return;
      }
      // Recheck native queue state after IPC. No await may follow this guard.
      guardNormalStartup(command, value, this.getState());
      dispatchPlaylistCommand(app, command);
      this.sendResult(value);
    } catch (error) {
      if (this.pending === pending) {
        const code =
          error instanceof PlaylistCommandError
            ? error.code
            : permitted
              ? 'PLAYLIST_DISPATCH_FAILED'
              : 'PLAYLIST_RESOLUTION_FAILED';
        this.sendResult(value, code);
      }
    } finally {
      if (this.pending === pending) this.clear();
    }
  };

  private ready(pending: Pending, app: PlaylistApp) {
    return (
      this.enabled &&
      this.pending === pending &&
      this.now() < pending.request.deadlineUnixMs &&
      app.isConnected &&
      this.getApp() === app &&
      this.isReady()
    );
  }

  private reportUnavailable(pending: Pending) {
    if (this.pending === pending) {
      this.sendResult(
        pending.request,
        this.now() >= pending.request.deadlineUnixMs
          ? 'PLAYLIST_START_TIMEOUT'
          : 'PLAYER_NOT_READY',
      );
    }
  }

  private sendResult(request: PlaylistStart, code?: PlaylistErrorCode) {
    this.ipc.send(playlistChannels.result, {
      requestId: request.requestId,
      generation: request.generation,
      ...(code ? { status: 'failed', code } : { status: 'dispatched' }),
    });
  }
}
