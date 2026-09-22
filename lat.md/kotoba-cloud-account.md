# Kotoba Cloud account

This fork's account surface: the Providers page signs in to Kotoba Cloud by connecting a personal API token, which becomes the profile's `KOTOBA_API_KEY`.

kotoba.cloud authenticates people with a Passkey in the browser and issues personal API tokens (`kc_pat_<principal>.<tokenId>.<mac>`) on `kotoba.cloud/account`; there is no device-code or OAuth flow to reuse. So the desktop's account *is* the token. [[src/main/kotoba-cloud-account.ts#connectKotobaCloud]] rejects anything that is not a `kc_pat_` token before any network call, proves a token against `GET https://kotoba.cloud/v1/billing/status` (the read-only route that accepts a token bearer), and only then writes `KOTOBA_API_KEY` through `setEnvValue` and mirrors the `kotoba` agent provider. [[src/main/kotoba-cloud-account.ts#kotobaCloudAccount]] re-verifies the stored token on every read so a revoked token shows as "no longer valid" rather than as connected; a token without `billing:read` stays connected with the balance shown as unknown, not as zero. [[src/main/kotoba-cloud-account.ts#disconnectKotobaCloud]] empties the key.

Upstream's Hermes One device login (`hermes-account.ts`, `hermesone-provision.ts`, agent sync) remains in the main process and preload but is no longer reachable from the Providers page.

## Passkey session

[[src/main/kotoba-cloud-session.ts#openKotobaCloudSignIn]] hosts `auth.kotoba.cloud/sign-in` in an Electron window whose cookies live in `persist:kotoba-cloud` (the pattern of `remote-oauth.ts`), polls `GET /v1/session` through that partition until the viewer is valid, and rejects when the window is closed or five minutes pass. [[src/main/kotoba-cloud-session.ts#issueDesktopToken]] then issues this machine's personal API token from that session (`POST /v1/account/api-token`, label `Kotoba desktop · <host>`, scopes `inference` + `billing:read`, `Origin: https://kotoba.cloud` because the worker's same-origin gate protects a browser's ambient cookies and this partition is reachable by no web page) and hands it to `connectKotobaCloud`. The session is also what the cloud gateway lane uses ([[kotoba-cloud-gateway]]).

## Sign-in modal

[[src/renderer/src/components/KotobaCloudAccountModal.tsx#KotobaCloudAccountModal]] replaces the device-code modal: "Sign in with Passkey" (the window above, then the token is issued and stored without pasting), and below it the manual path — a button that opens `kotoba.cloud/account` in the default browser, a password field for the token, and Connect, which shows the server's refusal by name (`token-revoked`, `sign-in-required`, a scope refusal) and stores nothing on failure.

## Tests

[[src/main/kotoba-cloud-account.test.ts]] drives the module with an in-memory `.env` and a scripted `fetch`: the bearer and route it calls, the balance read from `balances[scope=ai].availableMicroUSD`, 401 refused and nothing stored, 403 kept with the balance unknown, a non-token rejected without a request, and re-verification of a stored token turning `live` off when the server says revoked.
