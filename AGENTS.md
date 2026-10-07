# Repository instructions

For every major user-visible bot update, append an immutable entry to `src/releases.ts` with a new unique release ID, a concise changelog, and accurate added/changed/removed slash-command lists. Keep previous entries unchanged. The latest entry is announced automatically through the durable outbox; do not send release messages manually or bump the release ID for routine fixes or redeploys.

Watchlist mutations must remain atomic with their full-list public announcement. Preserve no-op deduplication, persistent exclusions, test-channel routing, delivery receipts and signal-only behavior. Announcements must not use chart-rendering resources.

Run `npm run verify` and `npm run worker:build` for runtime changes. Do not edit credentials or the bundled chart library to implement features.
