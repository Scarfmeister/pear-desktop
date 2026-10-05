export const PLAYLIST_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
export const PLAYLIST_START_TIMEOUT_MS = 5_000;

export const playlistChannels = {
  start: 'peard:api-playlist-start',
  permit: 'peard:api-playlist-permit',
  result: 'peard:api-playlist-result',
  cancel: 'peard:api-playlist-cancel',
} as const;

export const playlistErrorStatus = {
  INVALID_PLAYLIST_REQUEST: 400,
  PLAYLIST_START_BUSY: 409,
  PLAYLIST_UNAVAILABLE: 422,
  NATIVE_PLAYLIST_CONTROL_UNAVAILABLE: 501,
  NATIVE_PLAYLIST_DISPATCH_UNAVAILABLE: 501,
  PLAYLIST_RESOLUTION_FAILED: 502,
  PLAYLIST_DISPATCH_FAILED: 502,
  PLAYER_NOT_READY: 503,
  PLAYLIST_START_TIMEOUT: 504,
} as const;

export type PlaylistErrorCode = keyof typeof playlistErrorStatus;
export type PlaylistErrorStatus =
  (typeof playlistErrorStatus)[PlaylistErrorCode];
export type PlaylistRequest = { playlistId: string; shuffle: boolean };
export type PlaylistDispatch = PlaylistRequest & { status: 'dispatched' };
export type PlaylistError = {
  error: { code: PlaylistErrorCode; dispatch: 'not_dispatched' | 'unknown' };
};
export type PlaylistCorrelation = { requestId: string; generation: string };
export type PlaylistStart = PlaylistRequest &
  PlaylistCorrelation & { deadlineUnixMs: number };
export type PlaylistResult = PlaylistCorrelation &
  ({ status: 'dispatched' } | { status: 'failed'; code: PlaylistErrorCode });

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isCorrelation = (
  value: unknown,
): value is PlaylistCorrelation & Record<string, unknown> =>
  isRecord(value) &&
  typeof value.requestId === 'string' &&
  /^[A-Za-z0-9-]{1,64}$/.test(value.requestId) &&
  typeof value.generation === 'string' &&
  /^[A-Za-z0-9-]{1,64}$/.test(value.generation);

export const isPlaylistStart = (value: unknown): value is PlaylistStart =>
  isRecord(value) &&
  isCorrelation(value) &&
  typeof value.playlistId === 'string' &&
  PLAYLIST_ID_PATTERN.test(value.playlistId) &&
  typeof value.shuffle === 'boolean' &&
  typeof value.deadlineUnixMs === 'number' &&
  Number.isSafeInteger(value.deadlineUnixMs) &&
  value.deadlineUnixMs > 0;

export const isPlaylistResult = (value: unknown): value is PlaylistResult =>
  isRecord(value) &&
  isCorrelation(value) &&
  (value.status === 'dispatched' ||
    (value.status === 'failed' &&
      typeof value.code === 'string' &&
      Object.hasOwn(playlistErrorStatus, value.code)));

export const playlistFailure = (
  code: PlaylistErrorCode,
  dispatch: PlaylistError['error']['dispatch'] = 'not_dispatched',
): PlaylistError => ({ error: { code, dispatch } });
