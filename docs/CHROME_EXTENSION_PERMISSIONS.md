# Chrome extension: permissions review and privacy statement (QG-906)

Review of `packages/chrome-extension/manifest.json`. A test (`tests/extension-package.test.ts`) fails if the
permissions, CSP or restricted keys below change, so a change needs a conscious edit of both.

## Manifest

| Key | Value | Why |
| --- | --- | --- |
| `permissions` | `activeTab`, `storage` | exactly these two |
| `activeTab` | granted by the person clicking the toolbar icon, for that tab, until it navigates or closes | the only way the popup learns the tab's address. No standing access to any site. |
| `storage` | `chrome.storage.local` | the bridge port, the pairing token and the id of the last scan job |
| `host_permissions` | none | requests to the bridge succeed through the bridge's exact-origin CORS answer, so no host access is needed |
| content scripts, `scripting`, background/service worker, `tabs`, `webRequest`, `cookies`, `history`, `declarativeNetRequest`, `externally_connectable`, `web_accessible_resources`, DevTools page | absent | nothing in the extension reads, modifies or observes pages or traffic |
| `minimum_chrome_version` | 114 | `chrome.storage` and `tabs.query` promises, MV3 action popup |

Not requested on purpose: `tabs` (would expose every tab's address), `<all_urls>` (would let the extension read every
site), `scripting` (would allow injecting code into pages).

## Content Security Policy (extension pages)

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src http://127.0.0.1:*;
base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

No inline script or style, no `eval`, no remote code, no remote fonts or images, no frames. The only network target is
loopback. The build is one local script and one stylesheet; the test checks the built folder for `eval`, `new Function`,
inline handlers and remote references. React sets no inline `style` attributes here, because `style-src 'self'` would
block them.

## Threats considered

| Threat | Control |
| --- | --- |
| A web page talks to the bridge | The bridge accepts only exact origins (extension id, Tauri, loopback dashboard); the smoke test shows a normal page's request is blocked by the browser. |
| Another extension or site uses the token | The token sits in this extension's `chrome.storage.local`, not `sync`, not page-accessible. The bridge pins it to this extension's origin (a stolen token from another origin is `401`). |
| The extension scans something the person did not choose | Target is the active tab only, shown in full, consent per scan, refused schemes listed in CHROME_EXTENSION.md. |
| SSRF through the scan | The scan opens whatever the person consented to from their own machine; that is the feature. The bridge refuses non-http(s) and credentials. Link-local, private and loopback targets carry a visible note. |
| Secret scanner output reaches the browser | The bridge never returns gate logs; the extension only calls scan and result endpoints. |
| Verdict tampering | The extension displays `decision` and `exitCode` from the bridge unchanged and has no pass/fail logic. |
| Token theft by local malware | Not defended: malware running as the same user can read Chrome's profile and the project directory. Same limit as the bridge. |

## Privacy statement (draft for the store listing)

QualityGate for Chrome sends no data to the developers or any third party and has no analytics, advertising, accounts
or remote code. When you press **Run scan**, the address of the current tab (without its `#fragment`) is sent to the
QualityGate bridge running on your own computer (`127.0.0.1`). The bridge opens that address with Lighthouse using the
Chrome installed on your computer and returns scores, findings and a run id. The extension stores three values in
`chrome.storage.local` on your device: the bridge port, a pairing token and the id of your last scan; **Unpair**
removes the token. The extension does not read page content, cookies, history or other tabs, and has no access to any
site except the tab you activate by clicking its icon. Hosting a privacy policy URL is required by the store and is not
done (see the checklist).
