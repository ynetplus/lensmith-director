# Action-log JSON schema

`drive` writes `action-log.json` with one entry for each step that ran. The file is the complete event record for a driven run: consumers can use it to reconstruct when the cursor moved, when an action was posted, and when the result settled.

## Time base

Every time value is an integer number of milliseconds relative to `t0`, the page `load` moment for the run. Values in the same log can therefore be compared directly. Fields ending in `AtMs` describe an event timestamp; `settleMs` is a duration from the action to the settled result.

`index` is the zero-based step index from the input step list. Optional narration fields use the same time base: `voiceLineId` is the step's narration id (for example, `s2`) and `voiceStartMs` is when that line started.

## Entry types

### `click`

A web or native click. Web entries identify the target with `selector`; native entries also include `app` and `ax`.

| Field | Type | Meaning |
| --- | --- | --- |
| `index` | number | Zero-based step index. |
| `type` | `"click"` | Entry discriminator. |
| `selector` | string | Web selector, or the described native locator. |
| `label` | string? | Optional human-readable step label. |
| `startedAtMs` | number | Start of the cursor movement. |
| `clickedAtMs` | number | Time the click was posted. |
| `screenX`, `screenY` | number | OS-screen point used for the click. |
| `boundingBox` | object | Target frame in CSS pixels: `x`, `y`, `width`, `height`. |
| `settleMs` | number | Time from the click until the result settled. |
| `app`, `ax`, `settleReason` | optional | Native-app metadata and the settle outcome (quiet, expect, or cap). |
| `button` | `"right"`? | Present only for a right-click. |

Example:

```json
{
  "index": 0,
  "type": "click",
  "selector": "button[type=submit]",
  "label": "Submit the form",
  "startedAtMs": 420,
  "clickedAtMs": 1110,
  "screenX": 836,
  "screenY": 492,
  "boundingBox": { "x": 780, "y": 460, "width": 112, "height": 48 },
  "settleMs": 286
}
```

### `wait`

A wait marker. It records deliberate pauses so the gaps in the timeline remain explainable.

| Field | Type | Meaning |
| --- | --- | --- |
| `index` | number | Zero-based step index. |
| `type` | `"wait"` | Entry discriminator. |
| `atMs` | number | When the wait began. |
| `ms` | number | Wait duration in milliseconds. |
| `app`, `until` | optional | Native-app metadata when waiting for an accessibility target. |

Example:

```json
{
  "index": 1,
  "type": "wait",
  "atMs": 1396,
  "ms": 1000
}
```

### `type`

A text-entry action. For privacy, a type entry intentionally carries **no `text` field**. The entered value is never written to the action log; `characterCount` is the only record of its size.

| Field | Type | Meaning |
| --- | --- | --- |
| `index` | number | Zero-based step index. |
| `type` | `"type"` | Entry discriminator. |
| `selector` | string | Web selector, or the described native locator. |
| `label` | string? | Optional human-readable step label. |
| `startedAtMs` | number | Start of the cursor movement. |
| `endedAtMs` | number | When the last character was entered. |
| `screenX`, `screenY` | number | OS-screen point used to focus the field. |
| `boundingBox` | object | Field frame in CSS pixels: `x`, `y`, `width`, `height`. |
| `characterCount` | number | Number of characters entered; never the characters themselves. |
| `settleMs` | number | Time from the last character until the result settled. |
| `app`, `ax`, `settleReason` | optional | Native-app metadata and the settle outcome. |

Example:

```json
{
  "index": 2,
  "type": "type",
  "selector": "#email",
  "startedAtMs": 1510,
  "endedAtMs": 1988,
  "screenX": 612,
  "screenY": 318,
  "boundingBox": { "x": 520, "y": 292, "width": 360, "height": 52 },
  "characterCount": 16,
  "settleMs": 120
}
```

### `hover`

A native hover action. It contains the native app and accessibility locator because there is no web selector.

| Field | Type | Meaning |
| --- | --- | --- |
| `index` | number | Zero-based step index. |
| `type` | `"hover"` | Entry discriminator. |
| `app` | string | Target app bundle id. |
| `selector` | string | Description of the accessibility locator. |
| `ax` | object | Accessibility locator used to resolve the target. |
| `startedAtMs` | number | Start of the cursor movement. |
| `hoveredAtMs` | number | When the cursor came to rest. |
| `screenX`, `screenY` | number | OS-screen point used for the hover. |
| `boundingBox` | object | Target frame in capture space. |
| `settleMs` | number | Time until the result settled. |
| `settleReason` | string | Why settling returned. |

Example:

```json
{
  "index": 3,
  "type": "hover",
  "app": "com.example.farol",
  "selector": "AXButton title=Waiting",
  "ax": { "role": "AXButton", "title": "Waiting" },
  "startedAtMs": 2140,
  "hoveredAtMs": 2840,
  "screenX": 1024,
  "screenY": 574,
  "boundingBox": { "x": 980, "y": 550, "width": 88, "height": 32 },
  "settleMs": 90,
  "settleReason": "quiet"
}
```

### `key`

A keyboard action. `keys` contains normalized chord names, never free-form text.

| Field | Type | Meaning |
| --- | --- | --- |
| `index` | number | Zero-based step index. |
| `type` | `"key"` | Entry discriminator. |
| `keys` | string[] | Normalized key or chord names, such as `cmd+shift+v`. |
| `atMs` | number | When the key press was posted. |
| `settleMs` | number | Time until the result settled. |
| `selector`, `boundingBox` | optional | Web focus target and zoom frame, when supplied. |
| `app`, `settleReason` | optional | Native-app metadata. |

Example:

```json
{
  "index": 4,
  "type": "key",
  "app": "com.example.farol",
  "keys": ["cmd+shift+v"],
  "atMs": 3020,
  "settleMs": 140,
  "settleReason": "expect"
}
```

### `activate`

A native app activation that brings an application to the front.

| Field | Type | Meaning |
| --- | --- | --- |
| `index` | number | Zero-based step index. |
| `type` | `"activate"` | Entry discriminator. |
| `app` | string | Target app bundle id. |
| `label` | string? | Optional human-readable step label. |
| `atMs` | number | When the activation was posted. |

Example:

```json
{
  "index": 5,
  "type": "activate",
  "app": "com.google.Chrome",
  "atMs": 3280
}
```

## TypeScript model

The canonical TypeScript definitions live in [`src/lib/actionLog.ts`]. The `ActionLogEntry` union contains `ActionLogClickEntry`, `ActionLogWaitEntry`, `ActionLogTypeEntry`, `ActionLogHoverEntry`, `ActionLogKeyEntry`, and `ActionLogActivateEntry`.
