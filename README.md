# Kotoba desktop (`cloud-kotoba/org-hermesone-hermes-desktop`)

**Kotoba** is the desktop app for [app.kotoba.cloud](https://app.kotoba.cloud/):
a native Electron app that installs, configures and chats with
[Hermes Agent](https://github.com/NousResearch/hermes-agent), wired to
**Kotoba Cloud inference** (`https://api.kotoba.cloud/v1`, personal API token
from [kotoba.cloud/account](https://kotoba.cloud/account)) as the first,
recommended provider.

It is a **fork of [`fathah/hermes-desktop`](https://github.com/fathah/hermes-desktop)
("Hermes One", [hermesone.org](https://hermesone.org), MIT)** — hence the
origin-plane name `org-hermesone-hermes-desktop` (the authority's registrable
domain reversed + the upstream subject; `manifest/origin-domains.edn`).
Upstream's README is kept verbatim as [`README.upstream.md`](README.upstream.md);
the [LICENSE](LICENSE) is upstream's MIT notice and applies to this fork.

## What this fork changes (and nothing else)

| area | upstream | this fork |
|---|---|---|
| product / bundle | `Hermes One`, `com.nousresearch.hermes` | `Kotoba`, `cloud.kotoba.desktop` |
| first provider card | Hermes One Inference (`inference.hermesone.org`) | **Kotoba Cloud** (`api.kotoba.cloud/v1`, env `KOTOBA_API_KEY`); Hermes One stays as the second card |
| account | "Hermes One account" — device login (RFC 8628) to upstream's backend, cloud agent sync, wallets | **Kotoba Cloud account**: Passkey sign-in happens in the browser on `kotoba.cloud/account`, the personal API token (`kc_pat_…`) is pasted into the app, proven against `GET /v1/billing/status`, stored as `KOTOBA_API_KEY` (= the provider key), balance shown. Upstream's device login stays in the main process but has no card |
| office decal | `HERMES ONE HQ` on the south wall | `KOTOBA HQ` (`kotoba-hq.webp`, same canvas) |
| auto-update feed | upstream GitHub releases | `https://app.kotoba.cloud/download/` (electron-updater `generic`) — a fork that kept upstream's feed would update itself back into Hermes One |
| icons / splash | Hermes One mark | the kotoba-lang mark (`src/renderer/src/assets/kotoba-mark.svg`, drawn from the 110 px org avatar) and the KOTOBA wordmark |
| Linux targets | AppImage, snap, deb, rpm | AppImage, deb (snapcraft / rpmbuild are not on the macOS build hosts) |
| GitHub Actions | on | **off** (`GET /repos/…/actions/permissions` → `enabled: false`, 2026-09-22). Builds run on a mac-mini; nothing runs on GitHub. |

Everything about *Hermes Agent* itself — the install script, `~/.hermes`,
profiles, sessions, skills, gateways — is upstream's and unchanged. The
"Hermes One account" features (device login, cloud agent sync, credits) still
talk to upstream's backend and are left as they are.

The app name is still overridable at runtime with `HERMES_DESKTOP_APP_NAME`
(main) / `VITE_HERMES_DESKTOP_APP_NAME` (renderer), as upstream allows.

## Versioning

The fork's version advances upstream's patch number (`0.7.7` → `0.7.8` for
the first fork-only release) so that electron-updater, which compares
semver, moves installed apps forward; a prerelease tag (`0.7.7-kotoba.1`)
would sort *below* upstream's `0.7.7` and never update anyone. When upstream
ships a version at or above ours, merge it and take the higher number.

## Download

<https://app.kotoba.cloud/> — the desktop section. Artifacts are
content-addressed (`kotoba.app.edn` records the CID of each release file) and
served from `https://app.kotoba.cloud/download/<file>`.

**Unsigned for now.** No *Developer ID Application* certificate (macOS) or
Authenticode certificate (Windows) exists in this workspace — only App Store
distribution certificates do (`secrets-location-map` → `mobile-publishing.md`).
macOS builds are ad-hoc signed by `build/afterPack.js`; Gatekeeper will ask
you to confirm on first launch (right-click → Open, or
`xattr -d com.apple.quarantine /Applications/Kotoba.app`). This is said on the
download page, not hidden.

## Build

```sh
npm ci                         # electron 44 + better-sqlite3 prebuilds
npm run typecheck && npm test
npm run build:mac              # dist/kotoba-desktop-<ver>-arm64.dmg (+ latest-mac.yml)
npm run build:linux            # dist/kotoba-desktop-<ver>-<arch>.AppImage, .deb
```

Windows (`npm run build:win`) needs a Windows host or wine; it is not built by
the mac-mini fleet.

Under the superproject, run heavy builds through the resource governor:
`node scripts/resource-guard.mjs run build -- npm run build:mac`.

## Keeping up with upstream

```sh
git remote add upstream https://github.com/fathah/hermes-desktop.git
git fetch upstream && git merge upstream/main
```

The fork's changes are deliberately small and listed above so that merges stay
cheap. Do not "clean up" upstream code in this repo — do it upstream.
