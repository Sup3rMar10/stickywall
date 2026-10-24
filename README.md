# Stickywall
📝 Because 'any other business' is never just one business.

Real-time retrospective boards. One person creates a board and shares an invite link; everyone else joins with just a display name. Three columns (Went well / Improve / Actions), drag-and-drop sticky notes, anonymous mode, dot-voting with a per-person limit, a shared 5-minute timer, live cursors, and Markdown export.

## Run it 🏃
Needs Node 22.13+ (it uses the built-in `node:sqlite`, so there's no native module to compile).

```
npm install
npm start          # http://127.0.0.1:3000
npm test           # 21 tests, spins up the server on a random port
```

Env vars: `PORT` (3000), `HOST` (127.0.0.1), `DB_PATH` (stickywall.db).

Open the page, create a board, click **Copy invite link**, and open the link in another browser profile (or another origin such as `localhost` vs `127.0.0.1`: the session lives in `localStorage`, so two tabs of the same browser are the same person).

## What's in here
- `src/validate.js`: schema for every WebSocket message (known type, exact keys, size and range limits, control-char stripping)
- `src/ws.js`: auth handshake, per-connection rate limit, handlers, per-client rendering of events
- `src/store.js`: SQLite via `node:sqlite`, server-assigned timestamps, vote limit enforced in a transaction
- `src/bus.js`: the pub/sub seam a Redis adapter would plug into
- `public/`: vanilla JS client, no build step
- `docs/ARCHITECTURE.md`, `docs/STEPS.md` (build notes + interview Q&A)

## What was actually tested
- 21 automated tests: auth, permissions, last-write-wins ordering, vote limits, anonymous stripping, validation, oversized/binary frames, rate limiting, XSS payload handling, export escaping, reconnect.
- Clicked through in Chrome with two origins as two users: add and edit a note, drag between columns, vote, start the timer, toggle anonymous, live cursors, kill and restart the server while connected (both clients reconnected and state was intact).

## Honest disclaimer
**This is a test app only. It is a local prototype that has never been deployed and is not production-ready.** Don't put real retrospective data or anything sensitive in it. Known gaps:
- **One process.** Rooms, presence and the per-IP limiters live in memory. The bus is an interface with a local implementation; the Redis version is described, not written.
- **Identity is a bearer token in `localStorage`.** Clear it and you lose your seat on the board, and the owner loses ownership (there's no recovery flow). Sessions never expire.
- **Drag and drop uses the HTML5 API**, which doesn't work on touch screens. Only tried in Chrome.
- **Moves are fractional positions** (`(a+b)/2`). Fine for a retro, but thousands of drops in the same spot would eventually run out of float precision.
- **Timer sync ignores network latency** (about half a round trip of skew, tens of ms).
- Don't expose it to the internet as is. It binds to loopback by default for that reason.

## Things that went wrong while building this 🙃
- Taking back a note's last vote crashed the handler: I'd put `CHECK (n > 0)` on the votes table and then tried to decrement to 0. The test suite caught it; the last vote now deletes the row.
- My own per-IP "max 10 boards" limiter 429'd the test suite halfway through. Limits are now an option to `createApp`, with a test for the limiter itself.
- Anonymous mode can't be done by the client hiding names. Events carry author ids on the bus and each connection's copy is stripped server-side, because a hidden field in a JSON payload is not hidden.

Ship the retro. 🫡
