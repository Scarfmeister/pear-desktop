import { createRoute } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';

import { type APIServerConfig, AuthStrategy } from '../../config';
import { playlistFailure } from '../../playlist-contract';
import { API_VERSION } from '../api-version';
import { JWTPayloadSchema } from '../scheme/auth';
import {
  PlaylistDispatchSchema,
  PlaylistErrorSchema,
  PlaylistRequestSchema,
} from '../scheme/playlist';

import type { PlaylistBroker } from '../playlist-broker';
import type { HonoApp } from '../types';
import type { BackendContext } from '@/types/contexts';

const errorContent = {
  'application/json': { schema: PlaylistErrorSchema },
};

const route = createRoute({
  method: 'post',
  path: `/api/${API_VERSION}/play-playlist`,
  tags: ['Control'],
  summary: 'Start a playlist using its native Play or Shuffle Play control',
  description:
    'One native startup; no fallback or automatic retry. A 200 acknowledges dispatch only. An unknown error outcome may already have started playback.',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: PlaylistRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Native command dispatched; playback is not confirmed',
      content: { 'application/json': { schema: PlaylistDispatchSchema } },
    },
    400: { description: 'Invalid JSON request', content: errorContent },
    401: { description: 'Existing API authorization denied' },
    409: {
      description: 'Another playlist startup is active',
      content: errorContent,
    },
    422: {
      description: 'Playlist unavailable or unplayable',
      content: errorContent,
    },
    501: {
      description: 'Native control or handler unsupported',
      content: errorContent,
    },
    502: {
      description: 'Resolution or dispatch failed',
      content: errorContent,
    },
    503: {
      description: 'Player or API adapter not ready',
      content: errorContent,
    },
    504: {
      description: 'Five-second startup deadline expired',
      content: errorContent,
    },
  },
});

export const register = (
  app: HonoApp,
  backend: BackendContext<APIServerConfig>,
  broker: PlaylistBroker,
) => {
  // Keep malformed JSON and wrong content types in the same safe error contract.
  app.use(route.path, async (ctx, next) => {
    if (ctx.req.method !== 'POST') return next();
    if (
      !/^application\/json(?:\s*;|\s*$)/i.test(
        ctx.req.header('content-type') ?? '',
      )
    ) {
      return ctx.json(playlistFailure('INVALID_PLAYLIST_REQUEST'), 400);
    }
    try {
      await ctx.req.json<unknown>();
    } catch {
      return ctx.json(playlistFailure('INVALID_PLAYLIST_REQUEST'), 400);
    }
    try {
      await next();
    } catch (error) {
      if (error instanceof HTTPException && error.status === 400) {
        return ctx.json(playlistFailure('INVALID_PLAYLIST_REQUEST'), 400);
      }
      throw error;
    }
  });

  app.openapi(
    route,
    async (ctx) => {
      const request = ctx.req.valid('json');
      const initial = await backend.getConfig();
      const principal = JWTPayloadSchema.safeParse(ctx.get('jwtPayload'));
      const authorize = (current: APIServerConfig) =>
        current.authStrategy === initial.authStrategy &&
        (initial.authStrategy === AuthStrategy.NONE ||
          (current.secret === initial.secret &&
            principal.success &&
            current.authorizedClients.includes(principal.data.id)));

      if (!authorize(initial)) return ctx.body('Unauthorized', 401);
      if (!initial.enabled) {
        return ctx.json(playlistFailure('PLAYER_NOT_READY'), 503);
      }
      const result = await broker.start(request, authorize, ctx.req.raw.signal);
      if (result.status === 401) return ctx.body('Unauthorized', 401);
      if (result.status === 200) return ctx.json(result.body, 200);
      return ctx.json(result.body, result.status);
    },
    (result, ctx) => {
      if (!result.success) {
        return ctx.json(playlistFailure('INVALID_PLAYLIST_REQUEST'), 400);
      }
      return undefined;
    },
  );
};
