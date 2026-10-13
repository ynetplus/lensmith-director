<!--
  Lensmith Director README. Built from the ratified cards of CR-LENSMITH-A006-4.
  Assets live in .github/assets/ (banner-director-light.svg, banner-director-dark.svg copied from the
  round's assets/ folder). Repo settings to set by hand: description "Drives a running web app with
  the real macOS cursor and directs a demo recording of it."; topics: demo-video, ai-agents, cli,
  macos, playwright, cursor; social preview: .github/assets/social-preview-director.png.
  Only constructs GitHub Markdown renders are used. No custom CSS, no scripts.
-->

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/banner-director-dark.svg">
    <img alt="Lensmith Director. Drives a running app with the real cursor and directs a demo recording of it." src=".github/assets/banner-director-light.svg" width="100%">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/ynetplus/lensmith-director/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/ynetplus/lensmith-director/actions/workflows/ci.yml/badge.svg"></a>
  <a href="./LICENSE"><img alt="licence Apache-2.0" src="https://img.shields.io/badge/licence-Apache--2.0-1A1D21"></a>
  <img alt="platform macOS" src="https://img.shields.io/badge/platform-macOS-1A1D21">
  <img alt="node 18 or newer" src="https://img.shields.io/badge/node-18%2B-1A1D21">
</p>

**Lensmith Director drives a running web app and directs a demo recording of it.** It opens your Chrome, moves the real macOS cursor to each element in a step list, clicks or types, and hands the recording engine the moments to zoom on. This repository is the *director*. The *engine* that records and renders is the main repository, [**lensmith**](https://github.com/ynetplus/lensmith); start there.

> **Read this before installing.** This tool moves your real mouse cursor and synthesises real mouse clicks. It does not simulate input inside a browser tab: it posts events to macOS itself, at the same level as your trackpad, and applications cannot tell the difference. That is the point: a screen recording captures the system cursor, so a demo can only show a cursor moving if something moves it. It follows that macOS will ask you to grant Accessibility permission by hand, that the machine is exclusive while a run lasts (a notification or your own hand on the trackpad will steal a click), and that mechanically this is the same capability as input-injection malware, built on the same public API (`CGEventPost`) as `cliclick`, Hammerspoon and PyAutoGUI. Nothing here is covert, hidden or silently installed. The threat model is in [SECURITY.md](./SECURITY.md).

## Quickstart for agents

```bash
# One-time warm-up, done by a person: sign in to the target app
# in the profile Director will reuse.
open -na "Google Chrome" --args --user-data-dir="$HOME/.lensmith-director/chrome-profile"

# The whole pipeline in one run: record, drive, compose, render.
# The engine is installed with Director.
lensmith-director demo --steps steps.json --out-dir out
# -> out/final.mp4, plus raw.mp4, action-log.json, zooms.json,
#    project.openscreen and demo-manifest.json
```

The render runs in the engine. On macOS it uses the GPU (Metal) by default; set `LENSMITH_RENDER_GPU=0` to force software rendering.

A step list is a URL and the clicks, typing and waits an agent wants shown:

```json
{
  "url": "https://example.com/login",
  "minViewportWidth": 1024,
  "steps": [
    { "type": "click", "selector": "#email", "label": "Focus the email field" },
    { "type": "type",  "selector": "#email", "text": "demo@example.com" },
    { "type": "type",  "selector": "#code",  "textFrom": { "keychain": { "service": "my-demo", "account": "otp" } } },
    { "type": "wait",  "ms": 1000 },
    { "type": "click", "selector": "button[type=submit]" }
  ]
}
```

Playwright finds each element and reads its position; the mouse that moves is the real one. A `type` step can take its text from the macOS keychain so a secret never sits in a file, and typed text is never written to any log.

Any step can carry a `say` line, the narration spoken over it, with at most one `[[mark]]` before the word the action should land on (mark names are letters, digits and `_`, the engine's rule):

```json
{ "type": "click", "selector": "#story", "say": "Open the [[story]] Buildr story" }
```

When any step has `say`, `demo` runs a narrate stage first: it writes `out/narration-script.json` (one line per narrated step, id `s<step index>`), runs the engine's `lensmith narrate --script out/narration-script.json --out out/narration --json`, and drives with `out/narration/timings.json`. The click lands as the marked word is spoken, and the result stays on screen until the line ends plus 600 ms. The audio files and `timings.json` are listed in `demo-manifest.json`. The voice is the engine's default (Kokoro `am_michael`); `--voice` and `--engine` pass through to `narrate`. After the film is rendered, a voiceover stage places each line where it started during the drive: it writes `out/voice-starts.json` (`{ "s0": <ms>, ... }`, taken from the action log with the same time base as the zoom regions: the recording starts at the log's zero, so a log time is the film time), runs the engine's `lensmith voiceover --video out/final.mp4 --narration out/narration/timings.json --starts out/voice-starts.json --out out/final-voiced.mp4`, and delivers `final-voiced.mp4`. In the manifest `rendered-video` is then the voiced film and `rendered-video-silent` is the silent `final.mp4`. Captions are burned in by default; `--captions burn|srt|none` passes through. Burning needs an ffmpeg built with libass; without it the stage fails with a clear message (use `--captions srt` or `none`). A step list without `say` runs exactly as before, with no voiceover stage.

**Continuous narration** (`demo --narration continuous`, or `"narration": "continuous"` at the top of the step list; `drive` honours the step-list field with `--narration <timings.json>`): the voice is the clock. Every step must have a `say` line (a silent step is refused before anything launches, naming its index); each line starts 300 ms after the previous one ends. When the cursor cannot reach the next mark in time (travel + dwell), the action may land up to 0.9 s after its word so the voice never waits; only a longer shortfall starts the line later, by the remainder, and a line is never cut. A line never waits for the previous click to settle: when the run falls behind, the click takes up the slack and may land up to 0.9 s after its word. Clicks otherwise land on their marks, the 800 ms breath is dropped, each zoom region ends when the next travel starts (the zoom-out may run under the voice, `underVoice: true` in `zooms.json`), and the result is held 1200 ms after the last word. The voice starts come from the plan. The default, `settle`, is unchanged.

## Commands

All of them except `cursor position`, `native doctor` and `native tree` post real input events.

| Command | Posts events | What it does |
|---|---|---|
| `cursor position` | no | Print the current cursor position. `--json` |
| `cursor move <x> <y>` | yes | Move the real cursor along an eased path. `--duration-ms` (default 500; 0 is rejected), `--json` |
| `cursor click` | yes | Click at the current cursor position. `--json` |
| `drive` | yes | Open Chrome, run a step list through the real cursor, write an action log and a zoom-regions fragment. `--steps`, `--out`, `--zooms`, `--profile-dir`, `--browser-channel`, `--keep-open`, `--narration <timings.json>` (a step's optional `say` line, at most one `[[mark]]`, is timed to line `s<index>`: `s0`, `s1`, …; the click lands on the mark and the result holds until the line ends + 600 ms) |
| `demo` | yes | Narrate the `say` lines (when any), record, drive, compose and render one clip, and write a manifest. `--steps`, `--out-dir`, `--profile-dir`, `--browser-channel`, `--voice`, `--engine`, `--captions burn\|srt\|none` (with `say` lines the delivered film is `final-voiced.mp4`) |
| `native doctor` | no | Check that this Mac can drive native apps. Never prompts. `--json` |
| `native tree` | no | Print an app's Accessibility tree to pick locators. `--app <bundleId>` (required), `--in`, `--depth`, `--json` |
| `worker` | yes | Watch a job directory and run `demo` for each job file, one at a time. `--jobs`, `--poll` |

`lensmith-director <command> --help` prints the live flag list.

## Shots

Every step in a step list is filmed in one of five named shots. Write the name in `"shot"`, or leave it
out and the default rule picks one; zoom scales and timings are never written into a script.

| Shot | What the viewer sees |
|---|---|
| `wide` | the whole page, no zoom |
| `close` | the step's target, zoomed (the default for `click`, `type` and `key`) |
| `follow` | stays zoomed and pans from the previous target to this one |
| `hold` | the camera keeps its current framing; nothing moves |
| `reveal` | zooms out from the current target to the whole page as the line starts |

Default rule: a step with an action is `close`; the last narrated step that only shows is `hold`;
any other narrated step that only shows is `wide`. Two `close` steps on the same spot share one zoom,
so the camera does not zoom out and back in between them. A `wide`, `follow` or `reveal` step may carry
several `[[mark]]`s in its `say` line when it maps each one to a selector in `"targets"`:

```json
{ "type": "wait", "ms": 1200, "shot": "wide",
  "say": "Every [[t1]] table, every [[t2]] relationship.",
  "targets": { "t1": "#table-a", "t2": "#table-b" } }
```

With continuous narration, a `wide` (or `reveal`) wait points without clicking: the cursor glides
to each mark's target so that it already rests on the target as the word is spoken, and stays there
until the next mark, while the page stays at 1x (a zoom open before the line closes at the line's
start); a `hold` step keeps the cursor still.

An unknown shot name, a mark without a target or a target without a mark is refused before anything
launches. `targets` are web selectors; native steps cannot use them yet.

## Native apps (macOS)

`drive` and `demo` can also film an app that is not a web page: Calculator, a menu-bar tool, a terminal app, a Tauri or Electron window. A step that names an `app` (a bundle id) is native and finds its element in the Accessibility (AX) tree. A step with a `selector` is a web step and works as before. `url` is needed only when a list has web steps.

| Step | Fields | What happens |
|---|---|---|
| `click` | `app`, `ax`, optional `expect`; on the web `selector`, optional `button` (`"left"` default, or `"right"`) | Cursor travels to the element, dwells, clicks for real; a web right-click is posted by the browser at the point the cursor reached, so the page opens its context menu |
| `type` | `app`, optional `ax` (clicked to focus), `text` or `textFrom.keychain` | Types at a human pace |
| `key` | `app`, `keys`, optional `zoom`; on the web `keys` with no `app`, optional `selector` (focused first) | Posts a chord such as `"cmd+shift+v"`, or an array of chords; a web key goes to the focused page (`enter` also names `return`, `fn` is refused) and needs `url` |
| `hover` | `app`, `ax`, optional `expect` | Cursor travels and dwells, no click |
| `activate` | `app` | Brings the app to the front |
| `wait` | `app`, `until`, `timeoutMs` | Waits for an element to appear (`wait` with `ms` is unchanged) |

Every step can still carry `label` and `say`.

A locator (`ax`) takes `identifier`, `role`, `title`, `label` (the AXDescription), `value`, `match` (`exact` or `contains`), `index`, `in` (`app`, `window`, `menubar` or `statusbar`), `path` and `point`. It is resolved in this order: `identifier`, then `role` with `title`, `label` or `value`, then `path`, then `point`. `point` is a window-relative position and the last resort: validation warns when it is used, because it breaks when the window moves or the app updates.

A web `demo` run records the page viewport only: before recording, the driven Chrome window is resized so the area below its tab strip and address bar is exactly 1920x1096 points, and the engine records its top 1920x1080 points (3840x2160 pixels on a Retina display) with no padding around it. The 16 extra points keep the window's rounded bottom corners out of the frame, so the page's bottom 16 points are not in the film. The film is the page from edge to edge, with no browser chrome, window frame or desktop. On a display too small for that, the viewport shrinks to the largest 16:9 size that fits and the run says so on stderr. Declaring `"capture": "window"` keeps the old behaviour (the whole Chrome window).

Two optional top-level fields describe the stage. `apps` lists the apps to launch before recording: `{ "bundleId", "frame", "args" }`. `capture` is `"auto"`, `"window"`, `"screen"` or `{ "region": { "x", "y", "width", "height" } }`. A region must be 16:9. `region` capture needs engine 0.2.0 or later.

`keys` accepts only fixed key names (letters, digits, `return`, `tab`, `space`, `escape`, the arrows, `f1` to `f12`, and a few punctuation names), and a printable key needs `cmd`, `ctrl` or `opt` with it. Free text, and so any secret, cannot go through `keys`: use `type`. A secret reaches a field only through `textFrom.keychain`; literal text into a secure field is refused, and typed text is never logged.

A worked example (the bundle id is made up):

```json
{
  "apps": [{ "bundleId": "com.example.farol", "frame": { "x": 0, "y": 25, "width": 1600, "height": 900 } }],
  "capture": "window",
  "steps": [
    { "type": "click", "app": "com.example.farol", "ax": { "role": "AXButton", "label": "new task", "match": "contains" } },
    { "type": "type", "app": "com.example.farol", "text": "echo hello" },
    { "type": "key", "app": "com.example.farol", "keys": "return", "zoom": { "role": "AXOutline" } },
    { "type": "hover", "app": "com.example.farol", "ax": { "value": "waiting", "match": "contains" }, "say": "One agent is [[waiting]]" }
  ]
}
```

Native mode needs two permissions, both granted to the terminal app you run Director from:

| Permission | Why | Where |
|---|---|---|
| Accessibility | Reading apps and posting keys and clicks | System Settings, Privacy & Security, Accessibility |
| Screen Recording | Capturing the film | System Settings, Privacy & Security, Screen Recording |

Workflow for a new target:

1. `lensmith-director native doctor` checks the helper, both permissions, and whether an app holds secure input. It never triggers a prompt and exits 1 when a required row fails. `--json` prints the engine `doctor` report shape.
2. `lensmith-director native tree --app com.apple.calculator` launches the app and prints its AX tree, one node per line, such as `[0,2,1] AXButton title="Save" label="" id="save" 812,430 64x24`. Pick locators from it. `--in app|window|menubar|statusbar`, `--depth <n>` and `--json` narrow or reshape it. It only reads; it posts no input and never reads secure-field values.
3. Write the step list, then run `demo`. Native steps in `demo` are supported on main as far as the drive step goes; capture of a `region` follows with engine 0.2.0 or later.

## Why the cursor moves the way it does

Motion is posted as a stream of events, never a warp, so the app underneath gets its hover states and the video never shows a teleport. The default recipe is an eased move of at most 700 ms followed by a 700 to 1200 ms dwell before the click, because the zoom detector in the engine looks for moments where the cursor stops: a slow, elegant glide never breaks its still threshold and produces no zoom at all. The measurements behind this are in `src/lib/timing.ts` and the Swift helper's header comment.

## Install

Requirements: macOS, Node.js 18 or newer, Google Chrome. `uv` is needed for narrated films, and `ffmpeg` built with libass for burned captions.

```bash
npm install -g lensmith-director
npx playwright install chromium
lensmith-director --help
```

The engine comes with Director and is found automatically. To also use the `lensmith` command directly, install both: `npm install -g lensmith-director lensmith`.

### From source

For contributors. This path needs Apple's command line tools (`xcode-select --install`) and the [lensmith](https://github.com/ynetplus/lensmith) engine built next door (`../lensmith/dist/cli.js`) or pointed to with `LENSMITH_ENGINE_BIN`.

```bash
git clone https://github.com/ynetplus/lensmith-director.git
cd lensmith-director
npm install
npm run build
npm run build:native:mac      # compiles the cursor helper into bin/
npm link                      # optional: makes `lensmith-director` available on PATH
```

Grant Accessibility to the terminal app you run it from (System Settings, Privacy & Security, Accessibility). Without the grant the helper refuses to post events and says so; nothing here works around the prompt.

## Safety

A step list is executable: whoever can supply one, or write into a `worker` queue directory, can make this machine click and type in your signed-in Chrome profile. Run it as a dedicated macOS user with nothing else signed in. What the tool can do, the consent gates, how secrets are handled and what a hostile step list could do are in [SECURITY.md](./SECURITY.md). Contributions: [CONTRIBUTING.md](./CONTRIBUTING.md); the test suite never moves the real cursor.

Native mode takes over keyboard and mouse: run it on a machine nobody is using.

## In progress

Planned and not shipped: a headless mode (`drive` and `demo` without a real cursor, for Linux and containers) and a `plan` helper that maps a URL's pages and clickable elements for the agent.

## Licence

Apache License 2.0, Copyright 2026 YNET Plus Inc. See [LICENSE](./LICENSE) and [NOTICE.md](./NOTICE.md).

<p align="center"><sub>A YNET Plus studio company.</sub></p>
