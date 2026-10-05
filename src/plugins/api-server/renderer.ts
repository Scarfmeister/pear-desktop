import { createRenderer } from '@/utils';

import { PlaylistAdapter } from './renderer/playlist-adapter';
import { readNativeState, type PlaylistApp } from './renderer/playlist-command';

import type { APIServerConfig } from './config';
import type { MusicPlayer } from '@/types/music-player';

type Properties = { adapter?: PlaylistAdapter; player?: MusicPlayer };

export const renderer = createRenderer<Properties, APIServerConfig>({
  start(ctx) {
    this.adapter?.stop();
    this.player = undefined;
    this.adapter = new PlaylistAdapter(
      ctx.ipc,
      () => {
        const app = document.querySelector<PlaylistApp>('ytmusic-app');
        return typeof app?.networkManager?.fetch === 'function' ? app : null;
      },
      () => {
        const current = document.querySelector<
          Element & MusicPlayer & { isReady?: () => boolean }
        >('#movie_player');
        return (
          current !== null &&
          current === this.player &&
          typeof current.isReady === 'function' &&
          current.isReady() === true
        );
      },
      () => readNativeState(document),
    );
    this.adapter.start();
  },
  onPlayerApiReady(player) {
    this.player = player;
  },
  stop() {
    this.adapter?.stop();
    this.adapter = undefined;
    this.player = undefined;
  },
});
