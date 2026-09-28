# Lil Homie

A personal, testing-only iPhone Web Push PWA. Current scope supersedes the older plans in `docs/`. No integrations with TicTaak, email, AI, chat, memory, chores, or printing.

Production: https://lil-homie.tainer.run — existing tainer Better Auth login, restricted to `lucas`.

## Install on iPhone

1. Open the URL in Safari and sign in.
2. Share → Add to Home Screen. If shown, keep Open as Web App enabled.
3. Launch Lil Homie from that icon and sign in again if necessary.
4. Press Enable notifications and allow the iOS prompt. Permission is never requested on page load.
5. Send a test. Expand More test scenarios for open, closed, locked, tap-to-open, denial, and stop/re-enable instructions.

For an unobstructed delivery test, allow Lock Screen/banner notifications and temporarily disable Focus or allow Lil Homie through it. iOS controls presentation; push-service acceptance is not evidence of device delivery. A test push expires after 120 seconds if it cannot be delivered. Each message is visible; no silent pushes are used.

## Architecture

Plain frontend, manifest, and service worker; Node 22 HTTP server, `web-push`, and built-in SQLite. One container runs a 500ms server scheduler. Jobs are stored with due times before acknowledging the request. The iPhone does not run the delayed timer.

The persistent `/data` volume stores `push.sqlite` (subscriptions and up to seven days of test history), SQLite WAL files, and `vapid.json` (generated once, permissions 0600). Never publish or commit this directory. Keep the database and keys together when backing up. Stop the container briefly for a consistent filesystem backup, or use SQLite's backup facilities. Removing the volume loses subscriptions and signing identity.

Queued jobs survive restarts. Jobs over five minutes late expire; jobs interrupted during a send become `uncertain` rather than being blindly retried. A send can be accepted without the phone displaying it. Transient errors are shown and require a deliberate repeat. 404/410 responses remove the subscription and cancel pending tests. Stop removes the current installation's subscription and pending jobs; a push already in flight cannot be recalled. Stop does not revoke iOS permission.

Standard Web Push delivery uses the browser's external push provider (Apple for iPhone). No external app account, Apple Developer membership, Firebase SDK, or push SaaS is required. The server needs outbound HTTPS to those providers. DNS, TLS and login use the existing tainer infrastructure. Supported subscription endpoints are allowlisted to Apple, Google and Mozilla to prevent arbitrary server-side URL requests.

The service worker always calls `showNotification`, even for malformed test data. Notification taps focus/navigate an existing app window or open the same-origin app URL. No fetch caching or offline API replay is used. A expired login may require signing in again after tapping. The installed service worker can process push without fetching the app API.

## Deployment

```sh
sudo docker compose up -d --build --wait
```

Host binding is `127.0.0.1:3215` → container port 3000. Caddy/tainer provides HTTPS and authenticated proxy headers. The backend requires `Remote-User: lucas` except for its local health endpoint; it must stay behind the trusted proxy on loopback. The proxy strips forged identity headers. POST endpoints require the exact origin, JSON and a custom header. Sending is limited to 10 tests per minute per account.

Configuration: `APP_ORIGIN`, `ALLOWED_USER` (required), `DATA_DIR`, `PORT`, `BIND_HOST`. No development login bypass exists. Do not expose this backend directly to the Internet. Deploy through the managed tainer publishing skill; never edit generated routes or Caddy files manually.

```sh
npm ci
npm test
npx playwright test test/ui.spec.js --workers=1
```

Browser tests emulate the trusted proxy and Push API. They verify page behavior, not real Apple delivery. They run on local port 3216 with temporary databases and simulated push sends. Node tests exercise authorization, CSRF, provider validation, restart persistence, scheduling, stopping, cleanup, rate limits and the service-worker notification/click handlers.

## Device verification still required

- Install on the actual iPhone Home Screen and verify login.
- Open app: send and observe a visible notification.
- Closed app: schedule, leave/swipe away, observe delivery.
- Locked phone: schedule, lock, observe after about 30 seconds.
- Deny the initial prompt; verify denied status, disabled send buttons and recovery instructions. Test revocation separately via iPhone Settings.
- Schedule then stop before due time; verify no notification arrives. Enable again and verify a new test arrives.
- Tap a notification; verify the installed app opens, including after login expiry.

Use “I saw it” only for notifications actually observed; these are explicit user reports stored locally on the device. The software does not infer a pass from a server response.
