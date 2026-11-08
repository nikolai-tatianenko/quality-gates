# Chrome Web Store submission checklist (QG-906)

**Status: nothing here has been submitted, and no store build or review has been done.** The checklist is what remains,
in order. Items marked "done" are in the repo and tested; everything else is open.

## Package

- [x] Manifest V3, minimal permissions (`activeTab`, `storage`), strict CSP; see CHROME_EXTENSION_PERMISSIONS.md.
- [x] `pnpm build` produces `packages/chrome-extension/dist` (manifest, popup, icons 16/48/128).
- [x] Built folder contains no remote code, `eval` or inline script (`tests/extension-package.test.ts`).
- [ ] Produce the upload zip from `dist/` (zip the folder contents, manifest at the root). No script does this yet.
- [ ] Choose the final extension name and check it against store naming and trademark policy.
- [ ] Set the release `version` (the manifest says `0.1.0`) and keep it in step with the package.
- [ ] Replace the generated placeholder icons with designed ones (store also wants a 128x128 listing icon).

## Listing (store dashboard)

- [ ] Developer account with the one-time registration fee.
- [ ] Single purpose statement: "Run a project's Lighthouse thresholds on the page you are viewing through a local QualityGate bridge."
- [ ] Short and detailed description; mention that a separate CLI (`qualitygate bridge`) is required, that it is open
      source and how to install it. An extension that does nothing without a companion tool must say so in the listing.
- [ ] At least one 1280x800 or 640x400 screenshot; `pnpm smoke:extension` produces popup screenshots in
      `.qualitygate/extension-smoke/` (380 px wide, to be placed on a canvas).
- [ ] Privacy policy URL: publish the statement from CHROME_EXTENSION_PERMISSIONS.md on a stable page.
- [ ] Privacy practices form: no user data collected or transmitted off the device; justify `activeTab` ("learn the
      address of the tab the user clicks the icon on") and `storage` ("remember the local bridge port, token and last job").
- [ ] Declare no remote code; certify compliance with the Limited Use policy (no user data is handled by the developer).
- [ ] Distribution: unlisted or private first, to test the review before going public.

## Before upload

- [ ] Run `pnpm check` and `pnpm smoke:extension` on the release commit; attach `verification.json`.
- [ ] Re-test pairing with the extension id that the store assigns. A store id differs from the unpacked one; the
      bridge accepts any well-formed id unless started with `--origin chrome-extension://<id>`, and documentation for
      pinning the store id should be added once it is known.
- [ ] Verify the real toolbar click grants `activeTab` in a hand test (automation cannot do it) and record the result.
- [ ] Check on Windows and Linux Chrome (only macOS Chrome was used).

## After release

- [ ] Decide on update cadence and how the extension and CLI versions stay compatible (the bridge reports `apiVersion: 1`;
      the extension does not check it yet).
- [ ] Optional: DevTools panel (not built), deep link into the dashboard run view (dashboard has none), screenshot/diff thumbnails (QG-905 remainder).
