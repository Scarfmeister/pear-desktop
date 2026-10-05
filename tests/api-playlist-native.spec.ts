import { test, expect } from '@playwright/test';

import {
  PlaylistCommandError,
  resolvePlaylistCommand,
} from '../src/plugins/api-server/renderer/playlist-command';
import {
  browse,
  ID,
  normal,
  responsiveHeader,
  shuffle,
  state,
} from './api-playlist-fixtures';

const request = (shuffle = false) => ({ playlistId: ID, shuffle });
const failure = (
  response: unknown,
  shuffled = false,
  nativeState: unknown = state(),
) => {
  try {
    resolvePlaylistCommand(response, request(shuffled), nativeState);
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(PlaylistCommandError);
    return (error as PlaylistCommandError).code;
  }
};

test('responsive header selects separate complete native commands without touching related/mix/queue endpoints', () => {
  for (const shuffled of [false, true]) {
    const resolved = resolvePlaylistCommand(
      browse(),
      request(shuffled),
      state(),
    );
    expect(resolved.command).toEqual(shuffled ? shuffle : normal);
    expect(resolved.actionName).toBe(
      shuffled ? 'yt-watch-playlist-endpoint' : 'yt-watch-endpoint',
    );
  }
});

test('detail and editable-detail headers support native play/shuffle controls independent of labels', () => {
  const detail = {
    menu: {
      menuRenderer: {
        topLevelButtons: [
          {
            buttonRenderer: {
              icon: { iconType: 'MUSIC_PLAY' },
              navigationEndpoint: normal,
            },
          },
          {
            buttonRenderer: {
              icon: { iconType: 'MUSIC_SHUFFLE' },
              command: shuffle,
            },
          },
        ],
      },
    },
  };
  for (const header of [
    { musicDetailHeaderRenderer: detail },
    {
      musicEditablePlaylistDetailHeaderRenderer: {
        header: { musicDetailHeaderRenderer: detail },
      },
    },
  ]) {
    for (const shuffled of [false, true]) {
      expect(
        resolvePlaylistCommand({ header }, request(shuffled), state()).command,
      ).toEqual(shuffled ? shuffle : normal);
    }
  }
});

test('modern play overrides and shuffle-button/menu entity relations use fresh complete commands', () => {
  const control = {
    buttons: [
      {
        musicPlayButtonRenderer: {
          onTapCommandEntityKey: 'play-key',
          playNavigationEndpoint: {
            watchEndpoint: { playlistId: 'wrong-fallback' },
          },
        },
      },
      {
        musicShuffleButtonRenderer: {
          button: {
            buttonRenderer: {
              command: { resolveCommand: { commandEntityKey: 'shuffle-key' } },
            },
          },
        },
      },
    ],
  };
  const response = {
    ...browse(control),
    frameworkUpdates: {
      entityBatchUpdate: {
        mutations: [
          {
            entityKey: 'play-key',
            type: 'ENTITY_MUTATION_TYPE_REPLACE',
            payload: { commandEntity: { key: 'play-key', command: normal } },
          },
          {
            entityKey: 'shuffle-key',
            type: 'ENTITY_MUTATION_TYPE_REPLACE',
            payload: {
              commandEntity: { key: 'shuffle-key', command: shuffle },
            },
          },
        ],
      },
    },
  };
  for (const shuffled of [false, true])
    expect(
      resolvePlaylistCommand(response, request(shuffled), state()).command,
    ).toEqual(shuffled ? shuffle : normal);
  const current = state();
  current.entities.commandEntity['menu-key'] = { command: shuffle };
  const menu = browse({
    buttons: [
      {
        menuRenderer: {
          items: [
            {
              menuNavigationItemRenderer: {
                icon: { iconType: 'MUSIC_SHUFFLE' },
                navigationEndpoint: {
                  resolveCommand: { commandEntityKey: 'menu-key' },
                },
              },
            },
          ],
        },
      },
    ],
  });
  expect(resolvePlaylistCommand(menu, request(true), current).command).toEqual(
    shuffle,
  );
});

test('missing, mismatched, duplicated, cyclic or partial entity relations never use a stale fallback', () => {
  const response = browse({
    buttons: [
      {
        musicPlayButtonRenderer: {
          onTapCommandEntityKey: 'key',
          playNavigationEndpoint: normal,
        },
      },
    ],
  });
  expect(failure(response)).toBe('NATIVE_PLAYLIST_CONTROL_UNAVAILABLE');
  for (const entity of [
    { key: 'different', command: normal },
    { command: { resolveCommand: { commandEntityKey: 'key' } } },
  ]) {
    const current = state();
    current.entities.commandEntity.key = entity;
    expect(failure(response, false, current)).toBe(
      'NATIVE_PLAYLIST_CONTROL_UNAVAILABLE',
    );
  }
  for (const type of [
    'ENTITY_MUTATION_TYPE_UPDATE',
    'ENTITY_MUTATION_TYPE_DELETE',
  ]) {
    const current = state();
    current.entities.commandEntity.key = { command: normal };
    const updated = {
      ...response,
      frameworkUpdates: {
        entityBatchUpdate: {
          mutations: [
            {
              entityKey: 'key',
              type,
              payload: { commandEntity: { command: normal } },
            },
          ],
        },
      },
    };
    expect(failure(updated, false, current)).toBe(
      'NATIVE_PLAYLIST_CONTROL_UNAVAILABLE',
    );
  }
});

test('native executor remains intact with one startup; unrelated and post-start operations are rejected', () => {
  const command = {
    clickTrackingParams: 'fixture-wrapper',
    commandExecutorCommand: {
      commands: [{ clearShuffleStateCommand: {} }, normal],
    },
  };
  const response = browse({
    buttons: [{ musicPlayButtonRenderer: { playNavigationEndpoint: command } }],
  });
  const resolved = resolvePlaylistCommand(response, request(), state());
  expect(resolved.command).toEqual(command);
  expect(resolved.actionName).toBe('yt-command-executor-command');
  for (const commands of [
    [normal, shuffle],
    [{ queueAddEndpoint: {} }, normal],
    [normal, { clearShuffleStateCommand: {} }],
    [],
  ]) {
    expect(
      failure(
        browse({
          buttons: [
            {
              musicPlayButtonRenderer: {
                playNavigationEndpoint: {
                  commandExecutorCommand: { commands },
                },
              },
            },
          ],
        }),
      ),
    ).toBe('NATIVE_PLAYLIST_CONTROL_UNAVAILABLE');
  }
});

test('wrong requested ID, ambiguous headers/commands and unsupported structures cannot select playback', () => {
  const duplicate = responsiveHeader();
  duplicate.buttons.push(duplicate.buttons[0]);
  const unsupported = [
    null,
    {},
    browse({ buttons: [] }),
    browse(duplicate),
    { header: { musicDetailHeaderRenderer: {} }, ...browse() },
    browse({
      buttons: [
        {
          musicPlayButtonRenderer: {
            playNavigationEndpoint: {
              watchEndpoint: { playlistId: 'RD_wrong', videoId: 'v' },
            },
          },
        },
      ],
    }),
    browse({
      buttons: [
        {
          musicPlayButtonRenderer: {
            playNavigationEndpoint: {
              ...normal,
              urlEndpoint: { url: 'https://other.test' },
            },
          },
        },
      ],
    }),
  ];
  for (const value of unsupported)
    expect(failure(value)).toBe('NATIVE_PLAYLIST_CONTROL_UNAVAILABLE');
  expect(
    failure(
      browse({
        buttons: [
          {
            menuRenderer: {
              items: [
                {
                  menuNavigationItemRenderer: {
                    icon: { iconType: 'MIX' },
                    navigationEndpoint: shuffle,
                  },
                },
              ],
            },
          },
        ],
      }),
      true,
    ),
  ).toBe('NATIVE_PLAYLIST_CONTROL_UNAVAILABLE');
});

test('explicit errors, empty playlist shelves and disabled native controls are unavailable', () => {
  expect(failure({ error: { code: 404 } })).toBe('PLAYLIST_UNAVAILABLE');
  expect(
    failure({ error: { code: 500, message: 'private server detail' } }),
  ).toBe('PLAYLIST_RESOLUTION_FAILED');
  expect(
    failure(
      browse({
        buttons: [
          {
            musicPlayButtonRenderer: {
              isDisabled: true,
              playNavigationEndpoint: normal,
            },
          },
        ],
      }),
    ),
  ).toBe('PLAYLIST_UNAVAILABLE');
  const response = browse();
  response.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents.push(
    { musicPlaylistShelfRenderer: { contents: [] } } as never,
  );
  expect(failure(response)).toBe('PLAYLIST_UNAVAILABLE');
});

test('normal watch startup rejects unverified reuse of a shuffled same-playlist queue, including wrappers and unknown queue state', () => {
  expect(failure(browse(), false, state(true, ID))).toBe(
    'NATIVE_PLAYLIST_CONTROL_UNAVAILABLE',
  );
  expect(failure(browse(), false, null)).toBe(
    'NATIVE_PLAYLIST_CONTROL_UNAVAILABLE',
  );
  expect(
    failure(browse(), false, { queue: { shuffleEnabled: true, items: [{}] } }),
  ).toBe('NATIVE_PLAYLIST_CONTROL_UNAVAILABLE');
  expect(
    resolvePlaylistCommand(browse(), request(), state(true, 'PL_other'))
      .command,
  ).toEqual(normal);
  expect(
    resolvePlaylistCommand(browse(), request(), state(false, ID)).command,
  ).toEqual(normal);
  expect(
    resolvePlaylistCommand(browse(), request(true), state(true, ID)).command,
  ).toEqual(shuffle);
  const nativePlaylistNormal = browse({
    buttons: [
      {
        musicPlayButtonRenderer: {
          playNavigationEndpoint: {
            watchPlaylistEndpoint: {
              playlistId: ID,
              params: 'fixture-normal-native',
            },
          },
        },
      },
    ],
  });
  expect(
    resolvePlaylistCommand(nativePlaylistNormal, request(), state(true, ID))
      .actionName,
  ).toBe('yt-watch-playlist-endpoint');
});
