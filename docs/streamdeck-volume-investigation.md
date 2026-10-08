# Pear external volume investigation

Investigated 2026-10-07. Combined fork branch: `feature/streamdeck-api-extensions`.

## Upstream evidence

- Issue [pear-devs/pear-desktop#4458](https://github.com/pear-devs/pear-desktop/issues/4458) remains open. It reports POST 39/60/75 becoming GET and WebSocket 13/29/47, with audio plugins disabled.
- PR [#4672](https://github.com/pear-devs/pear-desktop/pull/4672) remains OPEN, with no merge commit or merged date. Reviewed its description, comments, reviews and inline discussion via GitHub API, and fetched the PR head before editing.
- Upstream master fetched SHA: `66bab974ad47d3374bf3108473d0d45b2edd22d6`. Its renderer still calls `ytmusic-player-bar.updateVolume`; no equivalent fix is present.
- PR base: `48dd89b98f24bd1b5abbb922593d1a41d3f1b49a`.
- PR commits: `08b860dca8450bbffc7d128aafb956972d488b47` (direct player write and slider sync), `618c7e033f606d536e0a711c392d43e188fee525` (precise-volume routing; current head).
- Pushed playlist branch starting SHA: `b5f13f65c71ca8890c08f52c7d7becde5d855be9`; common ancestor with current upstream: `a8830222afffb4af98aaa9b19287ebc24952605b`. Although the playlist commit is newer by date, its underlying volume code predates/does not contain the proposed fix.
- The initial PR review raised precise-volume side effects. The author's follow-up routes through that plugin's `setVolume` channel to retain saved volume, tooltip, slider timers and HUD. Latest [review](https://github.com/pear-devs/pear-desktop/pull/4672#discussion_r3898016784) identifies NaN/Infinity/out-of-range propagation in shared controls; this remains applicable to the PR head.

## Root cause and integration

POST uses song controls → `peard:update-volume` → player-bar `updateVolume`, which transforms the percentage before forwarding it. The renderer's volumechange listener reads `MusicPlayer.getVolume()`, and both GET's cache and `VOLUME_CHANGED` report that player percentage. Repeated read/modify/write therefore repeatedly applies the curve.

Ported the reviewed two-commit PR's behavior onto the pushed playlist branch; no cherry-pick, rebase or wholesale upstream merge. The smallest integration preserves the playlist API and unrelated fork code. No client-specific inverse or logarithmic formula is used.

Deviations: share a bounded Zod number schema between HTTP and controls, reject invalid input before either plugin path, normalize valid fractions to nearest integer before both paths, and validate again at the standard renderer boundary. Zod 4 rejects non-finite numbers inherently. Extract the standard renderer operation into a small testable helper. UI slider values retain upstream's minimum nonzero display of 5; that display never changes the requested player value. HTTP 204 remains dispatch-only, not confirmation of playback or volume; clients must wait for player state/events.

## Exact files

- `src/utils/volume.ts`: finite inclusive 0–100 Zod contract.
- `src/plugins/api-server/backend/scheme/set-volume.ts`: existing HTTP schema uses the shared contract; invalid JSON values receive the existing 400 convention.
- `src/providers/song-controls.ts`: validates protocol/API/MPRIS inputs, rounds, routes through precise-volume when enabled.
- `src/plugins/shortcuts/mpris.ts`: removes duplicate precise-volume branch; uses shared controls.
- `src/providers/external-volume.ts`: direct player write, validation and both slider updates.
- `src/renderer.ts`: delegates external volume IPC to helper; native UI and mute handlers unchanged.
- `tests/api-volume.spec.ts`: focused HTTP-schema/renderer contract and actual shared-control routing tests.
- `docs/streamdeck-volume-investigation.md`: this investigation and manual acceptance procedure.
- `src/plugins/api-server/README.md`: combined integration branch/commit locator and volume contract.

`POST /api/v1/play-playlist`, its native Normal/Shuffle semantics, and all playlist implementation/test files are unchanged. No separate Stream Deck repository was edited.

## Automated verification

Commands use Node 24 and pnpm 11 with the frozen lockfile.

- `pnpm test tests/api-volume.spec.ts tests/api-playlist src --reporter=line`: 49 passed (11 new volume, 38 existing playlist/other focused tests).
- `pnpm test --reporter=line`: 49 passed, Electron launch failed under sandbox. Retrying `pnpm test tests/index.test.js --reporter=line` outside the sandbox: 1 passed. This is an environment restriction, not a code regression; all 50 tests passed across the two runs.
- `pnpm typecheck` and `pnpm exec tsc -p tsconfig.test.json --noEmit`: pass.
- `pnpm lint`: pass with inherited warnings. Baseline lint likewise passed; no new errors remain.
- `pnpm format:check`: inherited failure on the same 17 unchanged files as the pre-edit baseline (config/store, si translation, index, menu, album-actions, ambient-mode, API websocket, crossfade, discord, downloader, TitleBar, precise-volume/override, synced-lyrics parser/providers, transparent-player, plugin fs utility). All seven changed/new TS files pass explicit `pnpm exec oxfmt --check`.
- `pnpm build`: pass (main, preload and renderer). Existing dynamic-import/chunk warnings remain.
- `git diff --check`: pass.

No lockfile/dependency changes or unrelated baseline formatting repairs were made.

The synthetic player reports the exact number passed to setVolume. Tests cover 0, 5, 25, 50, 75, 95, 100; sequential confirmed read/modify/write; rapid writes; finite/range/type rejection; integer rounding; slider minimum independent of player volume; precise-volume and standard control dispatch; and separate mute routing/state. These are routing-contract tests, not proof of a live YouTube Music player. HTTP tests mount the production schema on a minimal Hono route; actual shared controls are transpiled with mocked Electron/config dependencies. Existing production GET/WS already forward the same unchanged volume state from getVolume.

## Remaining Windows live-player acceptance

PowerShell, with Node >=22 and pnpm >=11 installed:

```powershell
git clone https://github.com/Scarfmeister/pear-desktop.git pear-desktop-api-extensions
cd pear-desktop-api-extensions
git checkout feature/streamdeck-api-extensions
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

For an installer instead: `pnpm dist:win` (output under `pack/`). Enable API Server, sign in, load a track, and connect the existing Stream Deck connector using its usual authentication. Test with precise-volume disabled and enabled (restart as required):

1. POST each 0/5/25/50/75/95/100; wait for `VOLUME_CHANGED`, then GET. Both must report the target integer. Compare the player API and audible volume; verify both player-bar sliders update.
2. Manually set 100%, press Volume Down (step 5), then Up: confirmed 95 then 100. Repeat rapidly and test the Plus dial. Verify no nonlinear decay or command-unconfirmed alerts after state settles.
3. Test native mouse/keyboard volume changes and precise-volume steps, tooltip/HUD, saved volume after restart, and slider display for values below 5. Verify API/WS reflect actual player percentage.
4. Toggle mute/unmute before and after volume changes, including zero; verify correct independent isMuted state and restoration behavior.
5. Repeat existing playlist Normal/Shuffle acceptance from the API README.

Live player, Windows hardware/dial, and signed-in audio testing cannot be performed in this Linux contract-test environment. API cache/event timing remains asynchronous as before; immediate GET after HTTP 204 can still observe old state.
