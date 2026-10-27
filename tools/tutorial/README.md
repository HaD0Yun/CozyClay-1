# Tutorial recorder

Turns an episode script into a tutorial video: it drives the Studio from the real startup chooser over CDP, screencasts it with a visible cursor, and writes `dist/tutorial/<episode>.mp4` (voice and burned-in captions in the `--locale` language) with `<episode>.ko.srt` and `<episode>.en.srt`.

```
voice.mjs (user clip > say > none) -> record.mjs (cue hold = clip + 0.4 s) -> assemble.mjs (capture)
  -> captions.mjs (PNG per cue, same Chrome) -> mux.mjs (caption band + overlays + voice) -> mp4
```

## Run

```sh
npm run tutorial:record -- first-video
npm run tutorial:record -- first-video --locale ko --size 1920x1080
```

`launch.mjs` starts `tools/dev-full.mjs` (the Agent panel needs the agent server) with an empty config dir and no provider keys or endpoints from your shell, so the panel shows the "Connect a model" card on any machine. It runs `record.mjs` inside `tools/qa-browser.mjs` and stops both. Ports: `TUTORIAL_DEV_PORT` (5594), `CDP_PORT` (5595), `COZYCLAY_LIVE_PORT` (5596), `COZYCLAY_OAUTH_PORT` (5597).

Against a dev server you already run:

```sh
QA_URL=http://127.0.0.1:5594/app/ CDP_PORT=5595 node tools/qa-browser.mjs -- node tools/tutorial/record.mjs first-video
```

`record.mjs` clears the origin's storage first (`Storage.clearDataForOrigin`), so it always starts from the chooser with the name field. Downloads from an export step go to a scratch dir.

Flags: `--locale en|ko` (UI, voice and caption language; `ko` writes `<episode>-ko.mp4`), `--size 1600x1000|1920x1080`, `--voice on|off`, `--wps-ko 1.6` and `--wps-en 2.2` (words per second for cues without a clip), `--fps 30`, `--out dist/tutorial`. `npm run build` empties `dist/`.

## Voice and captions

Voice is optional and runs before recording, because each cue's hold is its clip length plus 0.4 s (never shorter than its actions). Per narrated step, in order:

1. Your recording: `tools/tutorial/voice/<episode>/<step-id>.<ko|en>.<wav|m4a|mp3|aiff>` (ignored by git). Use the srt as the script.
2. macOS `say` (ko Yuna, en Samantha). A step's `speech: { ko, en }` changes what is read, not the caption.
3. Neither: the cue is silent and holds for its word count at `--wps-ko`/`--wps-en`.

Captions are PNGs drawn by the recording Chrome and laid with ffmpeg `overlay` in a band added under the frame (13% of its height), so they never cover the UI. ffmpeg needs `libx264` and `aac`; libass is not required. Korean captions need a Korean font (macOS has one; on Linux install `fonts-noto-cjk`). The mux stops if a clip is longer than its cue.

Requires ffmpeg on `PATH` or in `FFMPEG`; the recorder stops with one line if it is missing.

## Episodes

One file per episode in `episodes/`: a `.mjs` default export or a `.json` array of steps.

```js
{ id: "select", narration: { en: "...", ko: "..." }, click: "[data-node-id=characterA]", until: ".selected" }
```

Each step has exactly one action:

| Action | Value |
| --- | --- |
| `click` | selector, or a list clicked in order |
| `type` | text for the focused element, or `{ into: selector, text }` (clicks the field and replaces its value) |
| `key` | chord such as `Mod+B` or `Space` (`Mod` is Cmd on macOS, Ctrl elsewhere); a focused button is blurred first |
| `drag` | `{ from: selector or { js: expression giving { x, y } }, to: selector or { dx, dy } }` |
| `wait` | selector, or milliseconds |
| `hold` | milliseconds |
| `eval` | page expression, awaited; a result with `ok: false` stops the run |

`until` (optional) waits for a selector after the action. `narration` is optional after the first step: a silent step runs inside the cue of the narrated step before it. A cue lasts max(its actions, clip + 0.4 s) with voice, or max(its actions, 1 s + words / wps) without; its srt entry and caption span exactly that. `test/verify-tutorial-recorder.mjs` validates every rule above.
