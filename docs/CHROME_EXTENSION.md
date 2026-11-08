# Chrome extension (QG-901 to QG-906)

A Manifest V3 extension that runs your project's **configured Lighthouse thresholds** (performance, accessibility, SEO,
best practices) on the page you are looking at, through the [local bridge](BRIDGE.md) on your own machine, and shows the
bridge's verdict, scores, findings and run id. It lives in `packages/chrome-extension`.

It is not published to the Chrome Web Store. It is loaded unpacked (see below); the store steps are in
[CHROME_STORE_CHECKLIST.md](CHROME_STORE_CHECKLIST.md) and none of them is done.

## Who it helps

| Person | What they get |
| --- | --- |
| Engineer | Open the page being built, click the icon, see which Lighthouse threshold fails and why, with axe findings and rule links, without leaving the browser. Same thresholds as the team's `.qualitygate.yml`. |
| Team lead / engineering manager | Everyone checks against the same approved thresholds; the result names a run id that matches the files on disk. The team picture (trends, risks, time to green) stays in the [dashboard](../packages/dashboard/README.md) that the popup links to. |

## Use it

```bash
pnpm install && pnpm build                    # builds packages/chrome-extension/dist
qualitygate bridge --config .qualitygate.yml  # prints a pairing code, default port 4180
```

1. In Chrome open `chrome://extensions`, enable Developer mode, **Load unpacked**, choose
   `packages/chrome-extension/dist`.
2. Open the page you want to check and click the QualityGate toolbar icon. (Clicking the icon is what gives the
   extension `activeTab` access to that one tab.)
3. First time: type the pairing code from the terminal (and the port if you did not use 4180). The extension stores the
   token it receives in `chrome.storage.local`.
4. The popup shows the page address. Tick the consent box for that origin and press **Run scan**. Nothing is sent
   before this.
5. The result shows the bridge's verdict (`PASS` or `BLOCK` and its exit code), each score next to its minimum, the
   reasons for a block, findings (first ten, with rule and documentation link), the run id and the evidence file names,
   and a link to the dashboard. Close and reopen the popup at any time: a running or finished scan is picked up again by
   its job id. **Cancel scan** stops it on the bridge.

`Unpair` revokes the token on the bridge (when reachable) and forgets it locally.

## What it does and does not do

- **Consent, every time.** The scan target is the active tab's address with the `#fragment` removed. It is shown in full
  and the consent box names its origin. Consent is not remembered; every scan asks again. Refused outright (no scan
  button): `chrome:`, `chrome-extension:`, `file:`, `about:`, `data:`, `blob:`, `view-source:`, `javascript:` and any non
  http(s) scheme, addresses with a username or password, and Chrome Web Store pages. Local and private-network
  addresses and plain `http` get a visible note but are allowed, because scanning `localhost` is the main use.
- **The verdict is the bridge's.** The popup prints `decision` and `exitCode` from the stored run unchanged. It has no
  code that turns a failed or errored scan into a pass: a job that ends in `error` is shown as "could not run", an
  audit that errored shows `BLOCK` with exit code 2 and its error text.
- **No page content leaves the browser.** The extension never reads the page (no content script, no `scripting`
  permission). Only the address is sent, to `127.0.0.1`, and the bridge then opens it with Lighthouse using the local
  Chrome. Lighthouse does **not** use your signed-in session: a page behind a login audits the login page. An
  unreachable target is reported by the bridge as an errored scan.
- **QG-905 partly done.** Findings and the run id are linked to the stored run and the artifact names are listed. Not
  built: screenshots and diff thumbnails (the bridge does not serve them to the extension; downloading needs the bearer
  token, so a plain link would not work), and a deep link into the dashboard (the dashboard has no run route, so the
  link opens its start page at `http://127.0.0.1:4173/`; start it with `pnpm dashboard`).
- **Scans are not in the project history**, as documented for the bridge.
- **Not built: the optional DevTools panel.** Only the popup exists.
- One scan at a time (the bridge answers `409`; the popup shows its message).

## Design

```
popup.html + popup.js (React, one bundle)      packages/chrome-extension/src
  Popup.tsx    container (pairing, consent, scan lifecycle, storage) and PopupView (presentation only)
  client.ts    typed bridge client: loopback only, error kinds (down, unauthorized, conflict, ...)
  scan.ts      starts a scan, polls the job, cancels on request, then reads run, findings, artifacts
  target.ts    which tab URLs may be offered, and the notes shown with them
  state.ts     what chrome.storage.local holds: port, token, last job id
  messages.ts  every visible string (one place to translate)
```

It reuses the dashboard's design tokens (`packages/dashboard/src/tokens.css`, light and dark follow the browser) and
the bridge's own endpoints; there is no private import from other packages. The bundler is esbuild, as for the
dashboard and CLI (the repo has no Vite). Chrome API types are declared locally instead of adding `@types/chrome`.

## Failure handling

| Situation | What the popup does |
| --- | --- |
| No token stored | Shows the pairing form at once (the port can be changed there). |
| Bridge not running or wrong port | `Bridge not reachable` with `qualitygate bridge` to run, **Try again**, and **Unpair** to switch port. |
| Token revoked, expired or from another origin | Drops the token, returns to pairing with an explanation. |
| Wrong pairing code | Stays on the pairing form with the bridge's message (the code is single use, 10 minutes, 5 guesses). |
| Origin refused (`403`), project without thresholds (`409`), scan already running (`409`) | Shows the bridge's message; the person can retry. |
| Popup closed during a scan | The scan continues on the bridge; reopening resumes it. A job the bridge forgot (restart) is dropped. |

## Verification

- `pnpm test`: `tests/extension-logic.test.ts` (target rules, client error mapping, job polling and cancel, storage,
  and a run against the **real bridge** over loopback with an extension origin, including revoke and a refused origin),
  `tests/extension-popup.test.ts` (the popup in jsdom with a stubbed `chrome` and a fake bridge: pairing, consent gate,
  refusals, resume, cancel, revoked token, bridge down) and `tests/extension-package.test.ts` (manifest permissions,
  CSP, built folder contents). Coverage floors apply to the extension code like everything else.
- `pnpm smoke:extension` loads the built folder into real Chrome with puppeteer (`installExtension`), starts the built
  `qualitygate bridge`, pairs from the extension's own origin, runs a real Lighthouse scan of a local fixture, compares
  the popup's verdict and scores with the `report.json` on disk, reopens the popup (resume), revokes the token
  (returns to pairing), stops the bridge (reports not reachable), and checks that a normal web page cannot read the
  bridge. It writes screenshots to `.qualitygate/extension-smoke/`.
- **Not verified:** the real toolbar-icon click that grants `activeTab` (Chrome offers automation no way to do it; the
  smoke test replaces only `chrome.tabs.query` with one stub, everything else is real), other Chrome versions than the
  one in `verification.json`, Edge/Brave/Firefox, Windows and Linux, a Chrome Web Store build or review, and the
  `--load-extension` flag (current branded Chrome ignores it, so the smoke test uses puppeteer's `installExtension`).
