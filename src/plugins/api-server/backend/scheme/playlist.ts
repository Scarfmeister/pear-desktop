import { z } from '@hono/zod-openapi';

import {
  PLAYLIST_ID_PATTERN,
  playlistErrorStatus,
  type PlaylistErrorCode,
} from '../../playlist-contract';

export const PlaylistRequestSchema = z
  .object({
    playlistId: z.string().regex(PLAYLIST_ID_PATTERN),
    shuffle: z.boolean(),
  })
  .strict()
  .openapi('PlaylistStartRequest');

export const PlaylistDispatchSchema = PlaylistRequestSchema.extend({
  status: z.literal('dispatched'),
}).openapi('PlaylistStartDispatch', {
  description:
    'A native handler accepted dispatch. Playback and player state are not confirmed.',
});

export const PlaylistErrorSchema = z
  .object({
    error: z.object({
      code: z.enum(
        Object.keys(playlistErrorStatus) as [
          PlaylistErrorCode,
          ...PlaylistErrorCode[],
        ],
      ),
      dispatch: z.enum(['not_dispatched', 'unknown']),
    }),
  })
  .openapi('PlaylistStartError');
