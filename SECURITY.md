# Security policy and threat model

Lensmith Director synthesises real operating-system input. It moves the real macOS cursor and
posts real clicks (`CGEventPost`, the same API class that input-injection malware uses), types into
a real Chrome window, and can read secrets from the macOS keychain. This document says what it can
do, what stops it being misused, what it does with secrets, and where the limits are.

## Reporting a vulnerability

Please report privately through a GitHub private security advisory on this repository
(`ynetplus/lensmith-director` -> Security -> Report a vulnerability). Do not open a public issue for
a vulnerability. We aim to acknowledge a report within 72 hours.

Supported versions: this is a 0.x project; only the latest release receives fixes.

## What the tool can do

| Capability | Where | Notes |
|---|---|---|
| Move the real cursor and click anywhere the OS allows | `cursor move`, `cursor click`, and every `drive` / `demo` / `worker` run | Posted as HID events, so applications see them as trusted (`isTrusted: true`). |
| Launch your installed Google Chrome with a persistent profile and open any URL in the step list | `drive`, `demo`, `worker` | The profile can hold signed-in sessions; the run acts as that user on those sites. |
| Click and type into any element the step list's selectors find on that page | `drive`, `demo`, `worker` | Typing goes into the page through Playwright, not through OS keystrokes. |
| Read a generic-password item from the macOS keychain and type it into a page | `type` step with `textFrom.keychain` | See "Secrets". |
| Write files to any path it is given | `drive --out`, `--zooms`; `demo --out-dir`; `worker` job `outDir` | No path confinement; existing files are overwritten. |
| Start the engine's recorder and read the screen | `demo`, `worker` | Needs Screen Recording permission, granted to the terminal app, not to this tool. |
| Run unattended and repeatedly | `worker` | Runs every job file it finds in `queue/`. |

The Director itself sends no telemetry and makes no update check. Its own network traffic is Chrome
loading the pages named in the step list. A `demo` with `say` lines also runs the engine's `narrate`,
which downloads its voice model once on first use, and with `--engine edge` sends the line text to
Microsoft's online Read Aloud service.

## Consent gates

1. **macOS Accessibility permission.** Without it the OS silently discards posted events. The
   native helper checks `AXIsProcessTrusted()` before it posts the first event and refuses with a
   named error if it is not granted. The grant is a manual step in System Settings -> Privacy &
   Security -> Accessibility, and is attributed to the application at the head of the process chain
   (your terminal or editor), not to this tool. Nothing in this repository tries to bypass it.
2. **Delivery is verified.** After each move, and after each click that follows a move, the tool
   reads the cursor position back and fails if it differs from the expected position by more than
   1 px, so a silently dropped event is an error, not a successful run.
3. **Click targets stay inside the driven window.** The screen point for a click is computed from
   the element's position and refused (`TargetOutOfBoundsError`) if it falls outside the browser
   window's own content area, before any event is posted.
4. **Screen capture is proven before `worker` starts.** The worker enumerates real on-screen window
   titles and refuses to start if screen capture is not genuinely available.
5. **The tool acts only on the step list it is given.** There is no network listener, no daemon and
   no remote control channel. The inputs are command-line flags, a step-list file, and (for
   `worker`) job files in a directory.
6. **Chrome keeps its sandbox.** The browser is launched with its own sandbox enabled, never with
   Playwright's bundled Chromium, and never headless for a real run.

## Secrets

- A `type` step can take its value from the keychain instead of from the step-list file
  (`textFrom.keychain`), so a credential never has to be written into a file.
- The keychain read runs the fixed system binary `/usr/bin/security` with an argument array and no
  shell, so a `service` or `account` value containing shell metacharacters is passed as one literal
  argument and cannot run anything.
- The value is read immediately before typing, held in a local variable, and not stored on the
  step, the action log or any object that outlives the step.
- The action log records only `characterCount` for a `type` step, never the text, whether the text
  came from the file or from the keychain. The zoom fragment and `demo-manifest.json` contain no
  typed text either.
- Keychain error messages name the service and account but never the value or the raw output of
  `security`.
- The keychain read is bounded to 10 seconds.

## What a hostile step list can do

Treat a step list as executable. Anyone who can supply one, or write into a `worker` queue
directory, can make this machine:

- open any URL in your Chrome profile and click or type anywhere on that page while you are signed
  in as yourself (for example press a destructive button on a site you are signed in to);
- type any generic-password keychain item the `security` tool is allowed to read into a page the
  step list chooses, which can be a page the attacker controls (macOS may ask you to approve access
  to an item first, but that is the OS's decision, not this tool's);
- overwrite any file the user can write, through the output paths;
- hold the machine busy indefinitely (see "Known limitations").

What it cannot do on its own: it cannot post events without Accessibility permission, cannot click
outside the driven window, and cannot exfiltrate anything except by typing it into a page or
writing it to a file.

## Recommended isolation

- Run it as a **dedicated macOS user account** that has nothing else signed in, and grant
  Accessibility (and Screen Recording, for `demo` / `worker`) only to the terminal app in that
  account.
- Use a **dedicated Chrome profile** (`--profile-dir`) signed in only to the demo environment.
  Never point it at your everyday profile.
- Keep demo credentials in a **separate keychain** or use throwaway credentials, so an item the
  step list can name is not a real secret.
- Only run step lists you wrote or have read. Restrict write access to a `worker` `queue/`
  directory to the account that runs the worker.
- Do not use the machine while a run is in progress: events go to whatever window is under the
  cursor.
- The screen recording captures what is visible. Use masked fields (`type=password`) or disposable
  values for anything typed on camera.

## Known limitations

These are gaps found while writing this threat model. They are not fixed in this release.

1. **No allow-list for URLs or keychain items.** The step list's `url` is only checked to be a
   non-empty string, and `textFrom.keychain` accepts any service and account. A step list can send
   any readable keychain item to any page.
2. **Output paths are unconfined.** `--out`, `--zooms`, `--out-dir`, and a job's `steps` / `outDir`
   accept any path and overwrite existing files.
3. **A `wait` step has no upper bound** (only "positive and finite"), `type` text has no length
   limit, and `drive` has no overall run timeout, so a step list can hold the machine
   indefinitely. `--keep-open` is by design unbounded until SIGINT.
4. **`worker` has no authentication.** Any process that can write a file into `queue/` can start a
   job. The job directory's filesystem permissions are the only protection.
5. **Typed text can appear on screen.** A literal `text` value is stored in the step-list file in
   clear, and any typed value, including a keychain one, is visible in the recording if the field
   does not mask it. The page you type into also receives the value, by design.
6. **Failure output includes Playwright's own messages.** `drive` prints the underlying Playwright
   error text on a failed step, and `worker` stores up to 4000 characters of a failed child's
   stderr in its result file. The typed value is not added by this tool, and was not present in the
   one failure we inspected, but this is not guaranteed for every Playwright error.
7. **Reading the cursor is not gated.** `cursor position` works without Accessibility permission by
   design; it reveals only the pointer location.

Hardening for items 1 to 4 is tracked as follow-up work.

## Scope

In scope: the code in this repository, including the Swift helpers under `src/native/`.
Out of scope: vulnerabilities in Chrome, Playwright, macOS, or the separate
[`lensmith`](https://github.com/ynetplus/lensmith) engine (report engine issues there).
