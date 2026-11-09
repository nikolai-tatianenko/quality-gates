# Desktop signing and notarization plan (QG-805)

Status: **a plan, not a result.** No package has been built, signed, notarized or installed by the author; the Rust
shell builds unsigned on macOS and every step below is unverified (see [DESKTOP.md](DESKTOP.md)). Nothing here contains a secret. Certificates, passwords
and API keys never go into the repository, `tauri.conf.json`, workflow files or logs; they are supplied as CI secrets or
read from a local keychain at release time. The repository's `desktop-smoke.yml` uses none of them and builds unsigned.

## Why sign

An unsigned app is blocked or warned about by Gatekeeper (macOS) and SmartScreen (Windows), and a tool that runs a
project's commands should not train people to click through warnings. Signing is a release step, not a development one.

## macOS

Prerequisites
- An Apple Developer Program membership.
- A "Developer ID Application" certificate (for distribution outside the App Store), exported as a `.p12` with a strong
  password, or kept in a build machine keychain.
- Notarization credentials: an App Store Connect API key (issuer id, key id, `.p8` file) preferred over an Apple ID with an
  app-specific password.
- Hardened runtime on (`bundle.macOS.hardenedRuntime` is set in `tauri.conf.json`) and `entitlements.plist`. The only
  entitlement listed is `com.apple.security.cs.allow-jit`, because the bundled Node host needs JIT. Review before release;
  add nothing without a reason written down.

Steps (to be verified on a real macOS runner)
1. Build: `cargo tauri build` with `APPLE_SIGNING_IDENTITY` set to the certificate name; Tauri signs the app bundle.
2. Every nested executable, including the Node runtime once bundled (sidecar/resources), must be signed with the same
   identity and hardened runtime before the app is signed. Tauri signs binaries it knows about; verify with
   `codesign --verify --deep --strict --verbose=2 QualityGate.app`.
3. Notarize with `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH` (or the Apple ID variables), staple the ticket
   (`xcrun stapler staple`), and check with `spctl --assess --type execute --verbose QualityGate.app`.
4. Ship the `.dmg`; sign the dmg too.

Environment variable names above are the ones Tauri documents; confirm against the version you use.

## Windows

Prerequisites
- A code-signing certificate. An EV certificate (hardware token or a cloud signing service) gives immediate SmartScreen
  reputation; a standard OV certificate builds reputation over time. Alternatively Azure Trusted Signing.
- Never put a `.pfx` or its password in the repository. For CI prefer a cloud signing service so the private key does
  not leave its HSM; Tauri supports a custom `signCommand` in the Windows bundle config for that.

Steps (to be verified on a real Windows runner)
1. Build NSIS and/or MSI with `cargo tauri build`; set `bundle.windows.certificateThumbprint` or `signCommand` from CI at
   release time (not committed). `digestAlgorithm` is `sha256`; use an RFC 3161 timestamp server so signatures outlive the
   certificate.
2. Sign the bundled Node runtime and any other executable in the package.
3. Verify with `signtool verify /pa /v <installer>` and by installing on a clean VM with SmartScreen on.

## Linux

Not planned for the first release. If added: AppImage/deb signed with a GPG key whose fingerprint is published.

## Open items before the first signed release

- Ship a self-contained CLI and a Node runtime (or compile the host and bridge to one executable) so the packaged app
  does not depend on a system Node and `node_modules`. This changes what must be signed.
- Decide on updates. The updater plugin is intentionally not installed; adding it needs an update signing key (kept
  offline, public key in the config), a hosted manifest and a rollback plan.
- Smoke tests on clean macOS and Windows machines: install, first launch, pick a project, run the gates, notification
  appears, uninstall. The manual workflow only proves that the unsigned debug build compiles and produces a bundle; it does
  not launch the window.
- Reproducibility: pin the Rust toolchain (`rust-toolchain.toml`), run `cargo audit`, commit `Cargo.lock` after the first
  real build (it does not exist yet).
- Record the SHA-256 of each released artifact in the release notes ([RELEASING.md](RELEASING.md)).

## Secrets handling checklist

- [ ] Certificates and keys only in the CI secret store or a hardware token; rotated on staff change.
- [ ] Release job runs only on a protected tag, by manual approval, never on pull requests from forks.
- [ ] No secret printed in logs; `set +x` in signing steps.
- [ ] Notarization and signing logs reviewed for the hash of what was submitted.
