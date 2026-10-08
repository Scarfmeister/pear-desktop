import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ts } from 'ts-morph';
import { VolumePercentageSchema } from '../src/utils/volume';
import { test, expect } from '@playwright/test';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';

import { SetVolumeSchema } from '../src/plugins/api-server/backend/scheme/set-volume';
import { applyExternalVolume } from '../src/providers/external-volume';

function fixture() {
  let state = 100;
  const muted = true;
  const writes: number[] = [];
  const sliders = [{ value: '' }, { value: '' }];
  const api = {
    setVolume(value: number) {
      state = value;
      writes.push(value);
    },
  };
  const document = {
    querySelector(selector: string) {
      return sliders[selector === '#volume-slider' ? 0 : 1];
    },
  } as unknown as Pick<Document, 'querySelector'>;
  const app = new OpenAPIHono();
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/volume',
      request: {
        body: { content: { 'application/json': { schema: SetVolumeSchema } } },
      },
      responses: { 204: { description: 'Success' } },
    }),
    (ctx) => {
      applyExternalVolume(api, document, ctx.req.valid('json').volume);
      return ctx.body(null, 204);
    },
  );
  const post = (volume: unknown) =>
    app.request('/api/v1/volume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ volume }),
    });
  return {
    post,
    writes,
    sliders,
    read: () => ({ state, isMuted: muted }),
    apply: (value: number) => applyExternalVolume(api, document, value),
  };
}

for (const volume of [0, 5, 25, 50, 75, 95, 100]) {
  test(`HTTP schema and renderer player routing round-trip ${volume}`, async () => {
    const f = fixture();
    expect((await f.post(volume)).status).toBe(204);
    expect(f.read()).toEqual({ state: volume, isMuted: true });
    expect(f.writes).toEqual([volume]);
    expect(f.sliders.map((slider) => slider.value)).toEqual([
      String(volume),
      String(volume),
    ]);
  });
}

test('sequential read modify write and rapid writes retain the player scale', async () => {
  const f = fixture();
  for (const step of [-5, 5, -5, -5, -5]) {
    const target = f.read().state + step;
    await f.post(target);
    expect(f.read().state).toBe(target);
  }
  await Promise.all([25, 50, 75, 95].map(f.post));
  expect(f.writes).toEqual([95, 100, 95, 90, 85, 25, 50, 75, 95]);
});

test('invalid HTTP and direct IPC values cannot reach the player or sliders', async () => {
  const f = fixture();
  for (const value of [NaN, Infinity, -Infinity, -1, 101, null, '50', {}, []]) {
    expect(SetVolumeSchema.safeParse({ volume: value }).success).toBe(false);
    expect((await f.post(value)).status).toBe(400);
  }
  for (const value of [NaN, Infinity, -Infinity, -1, 101]) f.apply(value);
  expect(f.writes).toEqual([]);
  expect(f.sliders.map((slider) => slider.value)).toEqual(['', '']);
  expect(f.read()).toEqual({ state: 100, isMuted: true });
});

test('integer player contract rounds fractions; slider minimum does not alter player', () => {
  const f = fixture();
  f.apply(2);
  expect(f.read().state).toBe(2);
  expect(f.sliders.map((slider) => slider.value)).toEqual(['5', '5']);
  f.apply(50.6);
  expect(f.read()).toEqual({ state: 51, isMuted: true });
});

test('actual song controls validate and route both plugin modes; mute stays separate', async () => {
  const source = readFileSync('src/providers/song-controls.ts', 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  for (const enabled of [false, true]) {
    const exported: {
      getSongControls?: (window: unknown) => {
        setVolume(value: number | string[] | undefined): Promise<void>;
        muteUnmute(): void;
      };
    } = {};
    runInNewContext(compiled, {
      exports: exported,
      require: (name: string) => {
        if (name === 'electron') return { ipcMain: {} };
        if (name === '@/config')
          return { plugins: { isEnabled: async () => enabled } };
        if (name === '@/utils/volume') return { VolumePercentageSchema };
        if (name === '@/types/datahost-get-state') return { LikeType: {} };
        throw new Error(name);
      },
    });
    const sent: unknown[][] = [];
    const controls = exported.getSongControls!({
      webContents: {
        send: (...args: unknown[]) => sent.push(args),
      },
    });
    for (const value of [
      NaN,
      Infinity,
      -Infinity,
      -1,
      101,
      [],
      ['invalid'],
      undefined,
    ]) {
      await controls.setVolume(value);
    }
    expect(sent).toEqual([]);
    for (const value of [0, 5, 25, 50, 75, 95, 100])
      await controls.setVolume(value);
    await controls.setVolume(['50']);
    expect(sent).toEqual(
      [0, 5, 25, 50, 75, 95, 100, 50].map((value) => [
        enabled ? 'setVolume' : 'peard:update-volume',
        value,
      ]),
    );
    controls.muteUnmute();
    expect(sent.at(-1)).toEqual(['peard:toggle-mute']);
  }
});
