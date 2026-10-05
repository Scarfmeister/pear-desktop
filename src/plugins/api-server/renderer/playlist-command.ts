import {
  isRecord,
  type PlaylistErrorCode,
  type PlaylistRequest,
} from '../playlist-contract';

type RecordValue = Record<string, unknown>;
type ActionName =
  | 'yt-watch-endpoint'
  | 'yt-watch-playlist-endpoint'
  | 'yt-command-executor-command';

export type NativePlaylistCommand = {
  command: RecordValue;
  actionName: ActionName;
  canReuseQueue: boolean;
};

export type PlaylistApp = HTMLElement & {
  networkManager: {
    fetch: (path: string, body: { browseId: string }) => Promise<unknown>;
  };
};

export class PlaylistCommandError extends Error {
  constructor(public readonly code: PlaylistErrorCode) {
    super(code);
  }
}

const unsupported = (): never => {
  throw new PlaylistCommandError('NATIVE_PLAYLIST_CONTROL_UNAVAILABLE');
};

const field = (value: unknown, ...keys: string[]): unknown => {
  for (const key of keys) value = isRecord(value) ? value[key] : undefined;
  return value;
};

const list = (value: unknown, limit = 64): unknown[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit) return unsupported();
  return value;
};

const headerFrom = (value: unknown): RecordValue[] => {
  if (!isRecord(value)) return [];
  const headers: RecordValue[] = [];
  for (const kind of [
    'musicResponsiveHeaderRenderer',
    'musicDetailHeaderRenderer',
  ]) {
    if (Object.hasOwn(value, kind)) {
      if (!isRecord(value[kind])) return unsupported();
      headers.push(value[kind]);
    }
  }
  if (Object.hasOwn(value, 'musicEditablePlaylistDetailHeaderRenderer')) {
    headers.push(
      ...headerFrom(
        field(value, 'musicEditablePlaylistDetailHeaderRenderer', 'header'),
      ),
    );
  }
  return headers;
};

const sections = (response: unknown): unknown[] => {
  const result: unknown[] = [];
  for (const kind of [
    'singleColumnBrowseResultsRenderer',
    'twoColumnBrowseResultsRenderer',
  ]) {
    const tabs = list(field(response, 'contents', kind, 'tabs'), 8);
    if (!tabs.length) continue;
    const selected = tabs.filter(
      (tab) => field(tab, 'tabRenderer', 'selected') === true,
    );
    const tab =
      selected.length === 1
        ? selected[0]
        : tabs.length === 1
          ? tabs[0]
          : unsupported();
    result.push(
      ...list(
        field(tab, 'tabRenderer', 'content', 'sectionListRenderer', 'contents'),
      ),
    );
  }
  return result;
};

const entityCommand = (
  key: unknown,
  response: unknown,
  state: unknown,
): RecordValue => {
  if (typeof key !== 'string' || !key.length || key.length > 512)
    return unsupported();
  const mutations = list(
    field(response, 'frameworkUpdates', 'entityBatchUpdate', 'mutations'),
    512,
  );
  const matches = mutations.filter(
    (mutation) => field(mutation, 'entityKey') === key,
  );
  let entity: unknown;
  if (matches.length) {
    // Do not reconstruct partial updates or fall back to a stale store entity.
    if (
      matches.length !== 1 ||
      field(matches[0], 'type') !== 'ENTITY_MUTATION_TYPE_REPLACE'
    )
      return unsupported();
    entity = field(matches[0], 'payload', 'commandEntity');
  } else {
    entity = field(state, 'entities', 'commandEntity', key);
  }
  if (
    !isRecord(entity) ||
    (entity.key !== undefined && entity.key !== key) ||
    !isRecord(entity.command)
  )
    return unsupported();
  return entity.command;
};

const resolveReference = (
  command: unknown,
  response: unknown,
  state: unknown,
  depth = 0,
): RecordValue => {
  if (!isRecord(command) || depth > 4) return unsupported();
  if (Object.hasOwn(command, 'resolveCommand')) {
    if (
      Object.keys(command).some(
        (key) =>
          /(?:Endpoint|Command|Action)$/.test(key) && key !== 'resolveCommand',
      )
    )
      return unsupported();
    return resolveReference(
      entityCommand(
        field(command, 'resolveCommand', 'commandEntityKey'),
        response,
        state,
      ),
      response,
      state,
      depth + 1,
    );
  }
  return command;
};

const ensureEnabled = (control: RecordValue) => {
  if (control.isDisabled === true || control.disabled === true) {
    throw new PlaylistCommandError('PLAYLIST_UNAVAILABLE');
  }
};

const buttonCommand = (control: unknown, response: unknown, state: unknown) => {
  if (!isRecord(control)) return unsupported();
  ensureEnabled(control);
  return resolveReference(
    control.command ?? control.navigationEndpoint,
    response,
    state,
  );
};

const playCommand = (control: unknown, response: unknown, state: unknown) => {
  if (!isRecord(control)) return unsupported();
  ensureEnabled(control);
  const command = Object.hasOwn(control, 'onTapCommandEntityKey')
    ? entityCommand(control.onTapCommandEntityKey, response, state)
    : control.playNavigationEndpoint;
  return resolveReference(command, response, state);
};

/** Validate only native startup leaves and supported pre-start wrappers. */
const inspectCommand = (
  command: RecordValue,
  request: PlaylistRequest,
  depth = 0,
): { actionName: ActionName; canReuseQueue: boolean } => {
  if (depth > 4) return unsupported();
  const kinds = Object.keys(command).filter((key) =>
    /(?:Endpoint|Command|Action)$/.test(key),
  );
  if (kinds.length !== 1) return unsupported();
  const kind = kinds[0];
  if (kind === 'commandExecutorCommand') {
    const commands = list(field(command, kind, 'commands'), 8);
    if (!commands.length) return unsupported();
    // Keep the executor intact, with one startup last. Never post-start shuffle.
    for (const before of commands.slice(0, -1)) {
      if (!isRecord(before)) return unsupported();
      const keys = Object.keys(before).filter((key) =>
        /(?:Endpoint|Command|Action)$/.test(key),
      );
      if (
        keys.length !== 1 ||
        keys[0] !== 'clearShuffleStateCommand' ||
        request.shuffle ||
        !isRecord(before.clearShuffleStateCommand)
      )
        return unsupported();
    }
    const last = commands.at(-1);
    if (!isRecord(last)) return unsupported();
    const startup = inspectCommand(last, request, depth + 1);
    return {
      actionName: 'yt-command-executor-command',
      canReuseQueue: startup.canReuseQueue,
    };
  }
  if (kind !== 'watchEndpoint' && kind !== 'watchPlaylistEndpoint')
    return unsupported();
  const endpoint = command[kind];
  if (
    !isRecord(endpoint) ||
    endpoint.playlistId !== request.playlistId ||
    endpoint.continuePlayback === true
  )
    return unsupported();
  if (
    endpoint.videoId !== undefined &&
    (typeof endpoint.videoId !== 'string' || !endpoint.videoId)
  )
    return unsupported();
  return {
    actionName:
      kind === 'watchEndpoint'
        ? 'yt-watch-endpoint'
        : 'yt-watch-playlist-endpoint',
    canReuseQueue:
      kind === 'watchEndpoint' && typeof endpoint.videoId === 'string',
  };
};

export const guardNormalStartup = (
  command: NativePlaylistCommand,
  request: PlaylistRequest,
  state: unknown,
) => {
  if (request.shuffle || !command.canReuseQueue) return;
  const shuffle = field(state, 'queue', 'shuffleEnabled');
  if (shuffle === false) return;
  if (shuffle !== true) return unsupported();
  const items = field(state, 'queue', 'items');
  if (!Array.isArray(items)) return unsupported();
  for (const item of items) {
    const renderer =
      field(item, 'playlistPanelVideoRenderer') ??
      field(
        item,
        'playlistPanelVideoWrapperRenderer',
        'primaryRenderer',
        'playlistPanelVideoRenderer',
      );
    const id = field(
      renderer,
      'navigationEndpoint',
      'watchEndpoint',
      'playlistId',
    );
    if (typeof id !== 'string' || id === request.playlistId)
      return unsupported();
  }
  if (
    field(
      state,
      'player',
      'preloadedEndpoint_',
      'watchEndpoint',
      'playlistId',
    ) === request.playlistId
  )
    return unsupported();
};

export const resolvePlaylistCommand = (
  response: unknown,
  request: PlaylistRequest,
  state: unknown,
): NativePlaylistCommand => {
  if (!isRecord(response)) return unsupported();
  if (isRecord(response.error)) {
    throw new PlaylistCommandError(
      [400, 401, 403, 404].includes(Number(response.error.code))
        ? 'PLAYLIST_UNAVAILABLE'
        : 'PLAYLIST_RESOLUTION_FAILED',
    );
  }
  if (
    list(response.alerts).some(
      (alert) => field(alert, 'alertRenderer', 'type') === 'ERROR',
    )
  ) {
    throw new PlaylistCommandError('PLAYLIST_UNAVAILABLE');
  }
  const primary = sections(response);
  const headers = [
    ...headerFrom(response.header),
    ...primary.flatMap(headerFrom),
  ];
  if (headers.length !== 1) return unsupported();
  const header = headers[0];
  const shelves = [
    ...primary,
    ...list(
      field(
        response,
        'contents',
        'twoColumnBrowseResultsRenderer',
        'secondaryContents',
        'sectionListRenderer',
        'contents',
      ),
    ),
  ];
  if (
    shelves.some((section) => {
      const shelf = field(section, 'musicPlaylistShelfRenderer');
      return (
        isRecord(shelf) &&
        Array.isArray(shelf.contents) &&
        !shelf.contents.length &&
        !shelf.continuations
      );
    })
  ) {
    throw new PlaylistCommandError('PLAYLIST_UNAVAILABLE');
  }

  const buttons = list(header.buttons);
  const menus = [
    field(header, 'menu', 'menuRenderer'),
    ...buttons.map((button) => field(button, 'menuRenderer')),
  ].filter(isRecord);
  const controls = [
    ...buttons,
    ...menus.flatMap((menu) => list(menu.topLevelButtons)),
  ];
  const candidates: RecordValue[] = [];
  if (!request.shuffle) {
    const play = field(header, 'playButton', 'musicPlayButtonRenderer');
    if (play !== undefined) candidates.push(playCommand(play, response, state));
  }
  for (const control of controls) {
    if (
      !request.shuffle &&
      field(control, 'musicPlayButtonRenderer') !== undefined
    ) {
      candidates.push(
        playCommand(field(control, 'musicPlayButtonRenderer'), response, state),
      );
    }
    if (
      request.shuffle &&
      field(control, 'musicShuffleButtonRenderer') !== undefined
    ) {
      candidates.push(
        buttonCommand(
          field(
            control,
            'musicShuffleButtonRenderer',
            'button',
            'buttonRenderer',
          ),
          response,
          state,
        ),
      );
    }
    const icon = field(control, 'buttonRenderer', 'icon', 'iconType');
    if (icon === (request.shuffle ? 'MUSIC_SHUFFLE' : 'MUSIC_PLAY')) {
      candidates.push(
        buttonCommand(field(control, 'buttonRenderer'), response, state),
      );
    }
  }
  if (request.shuffle) {
    for (const menu of menus) {
      for (const item of list(menu.items)) {
        const navigation = field(item, 'menuNavigationItemRenderer');
        if (field(navigation, 'icon', 'iconType') === 'MUSIC_SHUFFLE') {
          if (!isRecord(navigation)) return unsupported();
          ensureEnabled(navigation);
          candidates.push(
            resolveReference(navigation.navigationEndpoint, response, state),
          );
        }
      }
    }
  }
  if (candidates.length !== 1) return unsupported();
  // Native data is JSON. Capture its complete command before the permit round trip.
  const command = structuredClone(candidates[0]);
  const resolved = { command, ...inspectCommand(command, request) };
  guardNormalStartup(resolved, request, state);
  return resolved;
};

export const readNativeState = (
  document: Pick<Document, 'querySelector'>,
): unknown => {
  const store = field(
    document.querySelector('#queue'),
    'queue',
    'store',
    'store',
  );
  if (!isRecord(store) || typeof store.getState !== 'function')
    return undefined;
  return (store.getState as () => unknown).call(store);
};

export const dispatchPlaylistCommand = (
  app: PlaylistApp,
  resolved: NativePlaylistCommand,
) => {
  const detail = {
    actionName: resolved.actionName,
    optionalAction: false,
    args: [resolved.command, app],
    returnValue: [] as unknown[],
  };
  app.dispatchEvent(
    new CustomEvent('yt-action', { detail, bubbles: true, composed: true }),
  );
  if (!detail.returnValue.length) {
    throw new PlaylistCommandError('NATIVE_PLAYLIST_DISPATCH_UNAVAILABLE');
  }
};
