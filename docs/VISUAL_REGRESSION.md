# Visual regression (optional plugin)

`@qualitygate/plugin-visual-regression` adds a gate type, `visual`, and the command `qualitygate visual approve`.
It compares screenshots your own command writes (for example Playwright) with an approved baseline that lives in git.
It is a separate workspace package (`packages/plugins/visual-regression`), off unless the config lists it under
`plugins:`; the core packages do not import it and work unchanged without it.

**Plugins are not sandboxed**: like every third-party plugin it runs inside QualityGate with your permissions
(see [Third-party plugins](PROJECT_SETUP.md#third-party-plugins) and [SECURITY.md](../SECURITY.md)).

## Setup

1. Make the package resolvable from the project's `node_modules` (the plugin loader reads
   `<project>/node_modules/<package>`; the package is private and not published to npm, so link it from a checkout of
   this repository, for example with a pnpm workspace or `pnpm link`). Linking was verified only when QualityGate runs
   under `tsx` from a checkout of this repository; it was **not** verified against the built `dist/qualitygate.mjs`
   bundle, and installing the package from a registry is unverified (it is not published).
2. Enable it and declare a `visual` gate in `.qualitygate.yml`:

```yaml
schemaVersion: 1
plugins:
  - "@qualitygate/plugin-visual-regression"
gates:
  - id: visual
    type: visual
    run: pnpm exec playwright test --project=screens   # any command that writes PNG screenshots
    current: qualitygate-visual/current                 # folder the command writes to (required)
    baseline: qualitygate-visual/approved               # approved screenshots, tracked in git (default)
    threshold: 0.1                                      # per-pixel colour distance, 0..1 (default 0.1)
    maxDiffRatio: 0                                     # share of pixels that may differ, 0..1 (default 0: any difference blocks)
    ignore: [clock]                                     # screenshot names to skip
    timeoutMs: 300000
```

`current` and `baseline` are project-relative folders; `..`, absolute paths and symlinks that leave the project are
refused. The two folders must differ and neither may contain the other (compared by real path, so a symlink alias
counts): the gate stops with an error before it runs the command, never with a pass. Add
`qualitygate-visual/current/` to `.gitignore` and commit `qualitygate-visual/approved/`. `maxPixels` (default
16 000 000, at most 64 000 000) is the largest image the plugin will decode.

Coupling to know about: the settings above (`current`, `baseline`, `threshold`, `maxDiffRatio`, `maxPixels`, `ignore`)
and their bounds are hard-coded in the core protocol schema (`packages/protocol/src/index.ts`), because a plugin
cannot yet declare its own settings. Changing one here means changing it there too, and the schema refuses them on
`command` gates.

## Playwright example

```ts
// tests/screens.spec.ts
import { test } from '@playwright/test';
test('home', async ({ page }) => {
  await page.goto('http://localhost:3000/');
  await page.screenshot({ path: 'qualitygate-visual/current/home.png', fullPage: true });
});
```

The file name (without `.png`) is the screenshot's name: 1 to 120 ASCII letters, digits, dots, dashes or underscores,
not starting with a dot or a dash. Only PNG files with a lower-case `.png` extension directly in `current` and
`baseline` count; `Home.PNG` is refused with a problem instead of being ignored. Pin the viewport, fonts, animations and test data so a run is reproducible.
This example is documented, not run here: Playwright itself was not part of the verification (see Verified below).

## What blocks

Per screenshot, the gate decides:

| Status | Meaning | Verdict |
| --- | --- | --- |
| `match` | same size, and the share of differing pixels is at most `maxDiffRatio` | PASS |
| `changed` | more pixels differ than `maxDiffRatio` allows, or the size differs, or an image cannot be read | BLOCK |
| `new` | there is no approved baseline | BLOCK |
| `missing` | an approved baseline exists but the run wrote no (or only a stale) screenshot | BLOCK |

The gate passes only when every screenshot matches. If the command exits non-zero, nothing is compared and the gate
blocks with the command's exit code. A run that finds no screenshots and no baselines is an error (exit 2), never a pass.

### Why a missing baseline blocks

If a new screenshot passed silently, deleting the baseline folder, renaming a screenshot, or adding a page without
approving it would turn the check off without anyone noticing. So the first run on a project blocks on every
screenshot as `new`; you look at them and approve them once, on purpose.

### Refused files

The plugin decodes 8-bit RGB and RGBA non-interlaced PNG with its own code (`node:zlib`, no dependency). Other PNG
kinds (palette, grayscale, 16-bit, interlaced), damaged files, images over `maxPixels`, files over 64 MB, symlinks,
names outside the allowed set, extensions that are not lower-case `.png` and names that differ only in case are reported
as an error finding and block; they never count as a match. File names in these messages are escaped (JSON style, no raw
control or escape characters). Screenshots last written before the command started are treated as not written. Browsers normally write 8-bit
RGB or RGBA PNG, which decodes, but that was not checked with Playwright; convert any other kind first.

## Evidence

Each run writes one file, `.qualitygate/<runId>/visual/visual.json`, plus copies of the images, so the run folder is
self-contained:

```
.qualitygate/<runId>/visual/
  visual.json
  approved/<name>.png   current/<name>.png   diff/<name>.png
```

```json
{ "schemaVersion": 1, "gateId": "visual", "baselineDir": "qualitygate-visual/approved",
  "items": [ { "name": "home", "status": "changed", "approved": "approved/home.png", "current": "current/home.png",
    "diff": "diff/home.png", "width": 1280, "height": 720, "diffPixels": 412, "diffRatio": 0.00045, "threshold": 0.1 } ] }
```

Paths are relative to the `visual` folder and `null` when the file is absent. `diff` (changed pixels in red over a faded
copy of the current image) exists only for a `changed` item with the same size. Optional additions: `note` on an item
(why it was refused) and `problems` at the top (refused files). One run holds at most one visual gate.
Findings carry the screenshot name in the message and the current image path in `file`.

## Approve

```sh
qualitygate visual approve home     # one screenshot
qualitygate visual approve --all    # every new and changed screenshot
```

Approving is explicit and never automatic: it is not part of `run`, and it never changes a stored run or verdict. It
copies the current screenshots of the **latest** run into the baseline folder and prints each file it changes
(`New: ...`, `Replaced: ...`, `Unchanged: ...`). Review the images, then commit the baseline folder. Run the gate again;
the new run is the one that counts.

- The latest run must be a run of the visual gate: `qualitygate run --gate visual`. If a later run did not include it,
  approve refuses instead of using older screenshots.
- It refuses when the baseline folder is outside the project, when a baseline file or the stored screenshot is a symlink,
  when the configuration's baseline folder differs from the one the run used, or when a screenshot cannot be read as a
  PNG. With `--all`, nothing is written unless every screenshot can be approved.
- `missing` screenshots are listed, not deleted: remove the file yourself if the screenshot no longer exists.
- Without the plugin in `plugins:` the command stops with exit 2 and says so.

## Verified

Unit tests (`tests/visual-*.test.ts`, `tests/plugin-context.test.ts`) cover PNG decoding and encoding, the comparer,
every status above, refusals, path safety and approve; an end-to-end test drives the real CLI (`run`, then
`visual approve`, then `run`) in a temporary project. Linking the plugin is verified only under `tsx` from a checkout, not against the built `dist/qualitygate.mjs`.
Not verified: a run with real Playwright and a real browser,
and installing the package from a registry (it is not published).
