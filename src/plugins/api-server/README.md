# Native playlist startup

`POST /api/v1/play-playlist` starts a requested playlist through YouTube Music's native Play or Shuffle Play control in the signed-in Pear renderer. It uses the API Server's existing JWT/authorized-client authentication; `NONE` continues to work when explicitly configured. The renderer/player and API Server must be enabled and ready.

```json
{ "playlistId": "PL_example", "shuffle": true }
```

Both fields are required. `playlistId` is a case-sensitive ID matching `^[A-Za-z0-9_-]{1,256}$`, not a URL or browse ID. `shuffle` is a boolean. Extra fields and malformed/non-JSON requests receive 400. URL parsing is a caller's responsibility.

An HTTP 200 JSON result is a native **dispatch acknowledgment**, not confirmation of playback:

```json
{ "playlistId": "PL_example", "shuffle": true, "status": "dispatched" }
```

Observe existing player/queue/shuffle state events to confirm playback. The route neither changes those events nor optimistically sets player state.

Errors contain a safe code and dispatch outcome:

```json
{ "error": { "code": "PLAYLIST_START_TIMEOUT", "dispatch": "unknown" } }
```

| HTTP | Code                                                                                       |
| ---- | ------------------------------------------------------------------------------------------ |
| 400  | `INVALID_PLAYLIST_REQUEST`                                                                 |
| 401  | Existing authentication response; also returned when authorization changes before dispatch |
| 409  | `PLAYLIST_START_BUSY`                                                                      |
| 422  | `PLAYLIST_UNAVAILABLE`                                                                     |
| 501  | `NATIVE_PLAYLIST_CONTROL_UNAVAILABLE`, `NATIVE_PLAYLIST_DISPATCH_UNAVAILABLE`              |
| 502  | `PLAYLIST_RESOLUTION_FAILED`, `PLAYLIST_DISPATCH_FAILED`                                   |
| 503  | `PLAYER_NOT_READY`                                                                         |
| 504  | `PLAYLIST_START_TIMEOUT`                                                                   |

One startup can be active, with a five-second deadline and no queue or automatic retry. Abort, API configuration/rebind/stop, or full renderer reload/destruction cancels pending work. Cancellation after a dispatch permit can have an `unknown` outcome: native playback may already have started. Do not automatically replay it. Authentication responses retain the existing format; other errors never include browse data, native tracking payloads, or tokens. Request/response schemas are included in `/doc` and `/swagger`.

The adapter selects only the requested playlist header's native control, resolves supported command entities, preserves the entire opaque command, and dispatches once through the native `yt-action` router. It never navigates to a constructed URL, builds a queue, guesses shuffle parameters, or starts normally and then shuffles/skips. Unsupported or ambiguous website layouts fail 501. Partial/missing command entities do not fall back to stale controls.

A native normal `watchEndpoint` can reuse an existing queue. When that queue is shuffled and contains the requested playlist (or cannot be verified), the adapter rejects the operation before dispatch. It does not manufacture a clear-shuffle command or claim Always Normal succeeded. A supplied native playlist-start command can take the fresh-queue path. This conservative limitation applies even to an executor wrapper with a clear-state command because its feature-flag behavior is not guaranteed.

Automated tests run with `pnpm test tests/api-playlist src --reporter=line`. They cover HTTP/authentication, IPC lifetime/sender checks, native response resolution and event dispatch with synthetic fixtures. Real signed-in playback is a separate acceptance gate: compare normal/shuffle API calls with the website controls from both the same and a different playlist, with shuffle off/on; record native queue/events and first audible track. Include unavailable/private/empty playlists, plugin re-enable, rebind/reload, cancellation before/after permission, and unsupported controls. A fixture acknowledgment alone does not prove audio or native mode semantics on an account.

## Combined Stream Deck integration

Fork branch `Scarfmeister/pear-desktop:feature/streamdeck-api-extensions` combines the native playlist endpoint with the external volume fix. The implementation commit is recorded in [the volume investigation](../../../docs/streamdeck-volume-investigation.md); the subsequent documentation commit identifies it without a self-referential SHA.

`POST /api/v1/volume` accepts finite numbers from 0 through 100 and rounds fractions to the player's integer contract. GET and `VOLUME_CHANGED` report the same player scale. Invalid inputs receive the existing validation 400 response. A 204 acknowledges dispatch; wait for confirmed state. Precise-volume retains its own state/UI update path, and mute remains separate.
