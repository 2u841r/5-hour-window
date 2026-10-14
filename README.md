# 5 Hour Window

Chrome extension (MV3, no build step) that tracks session and weekly usage limits for Claude, Cursor and Z.ai.

## Install

1. Open `chrome://extensions`, enable Developer mode.
2. Load unpacked, pick this folder.
3. Stay logged in to claude.ai and cursor.com in the same Chrome profile. No cookie copying needed: the extension calls each API with your existing browser session.

## How it works

- `src/background.js` polls every 15 min (configurable) via `chrome.alarms`, stores the latest snapshot and 14 days of history in `chrome.storage.local`.
- Requests run from the service worker with `credentials: 'include'`. A `declarativeNetRequest` session rule rewrites `Origin`/`Referer` on those requests so CSRF checks see the real site.
- Claude org id is read from the `lastActiveOrg` cookie, falling back to `/api/organizations`. Override in Settings.
- Z.ai: the dashboard authenticates with a Bearer JWT kept in `localStorage`, not a cookie. `src/zai-token.js` (content script on z.ai) captures it when you visit z.ai and stores it in `chrome.storage.local`. Order tried: API key from Settings, captured token, JWT cookie, plain cookies.
- Badge shows the highest weekly meter (color: green < 70, amber < 90, red). Notification once per reset window when a meter passes the alert threshold (default 80%).
- Dates show as DD/MM HH:mm in local time.

## Files

- `src/providers.js` fetch + normalize per provider. Add a provider by adding an entry to `PROVIDERS` and its domain to `ORIGINS` and `host_permissions`.
- `src/popup.*` bars, reset countdowns, weekly sparkline.
- `src/options.*` settings.

## Z.ai setup (one time)

Z.ai does not use cookies for its API, so the extension needs to pick up your session once:

1. Log in to Z.ai, then visit any `https://z.ai` page, for example [https://z.ai/manage-apikey/coding-plan/personal/usage](https://z.ai/manage-apikey/coding-plan/personal/usage).
2. Open the extension popup once. Z.ai data shows up.

After that it keeps updating in the background. If the Z.ai card later shows "Not logged in", your session expired: repeat the two steps above. Alternatively, paste a Z.ai API key in Settings.

## License

MIT, see [LICENSE](LICENSE).
