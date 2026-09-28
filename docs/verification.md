# Verification — 2026-09-28

Current deliverable: testing-only Web Push PWA. Earlier assistant plans are background and were not implemented.

## Completed

- `npm test`: 8 passing tests. Authentication, wrong-account rejection, CSRF, subscription/provider validation, durable subscriptions and VAPID keys, a 30-second job across restart, stop/cancel and re-enable, 404/410 cleanup, transient failure reporting, rate limit, interrupted-send recovery, visible service-worker notifications and notification-click routing.
- `npx playwright test test/ui.spec.js --workers=1 --reporter=list`: 2 passing Chromium tests at 430 × 932. Opt-in only on button click, schedule, stop/cancel, re-enable, explicit observation reporting, simulated denial/recovery instructions, no repeat permission prompt after denial, no horizontal overflow, no page JavaScript errors. Push and permission are simulated; these are not iPhone delivery tests.
- Mobile screenshot visually reviewed: `test-results/mobile.png` (local artifact, excluded from source control).
- Production Docker container healthy, bound only to `127.0.0.1:3215` → container port 3000.
- Managed publication: https://lil-homie.tainer.run, protected by the existing Better Auth gateway, app account restricted to `lucas`.
- Publishing helper passed loopback, firewall, WireGuard, origin, DNS, TLS and authentication checks. Public unauthenticated requests are denied; browser navigation redirects to login.
- External forged `Remote-User: lucas` request rejected with HTTP 401.
- Local missing identity rejected with HTTP 401; other account rejected with HTTP 403; authorized manifest returned HTTP 200 and declared standalone mode.
- Gateway liveness/readiness both passed following addition of the new exact hostname. Existing hostname entries were preserved.
- tainer dashboard rebuilt and healthy; the new Lil Homie link is present.
- Runtime dependency audit: zero known vulnerabilities reported by npm at installation.

## Needs the actual iPhone — no passes claimed

- Home Screen installation and login in the installed app.
- Actual visible notification with the app open.
- Actual visible notification with the app closed/swiped away.
- Delayed notification with the phone locked.
- Denying the initial iOS permission prompt, then recovery; revoking permission separately in Settings.
- No delivery after stopping a still-pending test, then successful delivery after enabling again.
- Tapping a notification opens the installed app, including after session expiry.

The app's “accepted” status only records the push provider's response. “I saw it” is an explicit user observation saved locally. Automated tests used isolated temporary databases and did not create production subscriptions or send real phone notifications.

## Files and infrastructure changed

Application files, tests and documentation were created inside `/home/xub/src/lil-homie`. The existing authentication host allowlist gained only `lil-homie.tainer.run`; the managed route was added; the dashboard gained a link. TicTaak code, configuration, database and container were not changed.
