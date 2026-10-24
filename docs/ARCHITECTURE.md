# Architecture

One Node process: Express serves the static client and a small JSON API, `ws` handles the realtime channel, SQLite (`node:sqlite`) stores everything.

```
 Browser (public/app.js)
   | POST /api/boards, /api/join       (create / join, no signup)
   | GET  /api/boards/:id/export.md    (Bearer session)
   | WebSocket /ws                     (first message = auth)
   v
+--------------------------------------------------------------------+
| Express (app.js)          ws (ws.js)                               |
|  CSP, per-IP limits        verifyClient: Origin must match Host    |
|  invite/join/export        auth -> Room -> handlers[type]          |
|        |                        |  validateMessage() + token bucket|
|        v                        v                                  |
|   Store (store.js)  <----  handler writes, stamps server ts        |
|   SQLite WAL                    |                                  |
|                                 v publish(boardId, rawEvent)       |
|                            LocalBus (bus.js)                       |
|                                 v                                  |
|                    Room.dispatch -> render(event, client) -> send  |
+--------------------------------------------------------------------+
```

## Why events are "raw" on the bus
A handler writes to SQLite, then publishes an event that contains author ids and no per-viewer fields. Each node's `Room.render()` turns it into the wire message for each connected client: strips authors in anonymous mode, sets `own`, adds a voter's own `remaining`. That keeps the bus payload identical for every recipient, which is what lets a Redis pub/sub adapter be a drop-in: publish the raw event, and every node renders for its own sockets.

## Identity
- Create board: server returns `boardId`, `invite` (16 random bytes) and the owner's `session` (32 random bytes). Only `sha256(session)` is stored.
- Join: `POST /api/join {invite, displayName}` returns a `session`. Members are capped at 50 per board.
- WebSocket: the first message must be `{t:'auth', session}` within 5s, otherwise the socket is closed (4001). The token never appears in a URL.
- The invite URL (`/join/<token>`) is only used once; after joining the browser moves to `/b/<boardId>`. `Referrer-Policy: no-referrer` stops the token leaking onward.

## WebSocket protocol

Client to server (every message validated; unknown keys rejected):

| `t` | Fields | Who |
|-----|--------|-----|
| `auth` | `session` | first message only |
| `note_add` | `col`, `text` (<=500), `cid?` | any member (max 300 notes/board) |
| `note_edit` | `id`, `text` | author only |
| `note_move` | `id`, `col`, `pos` | any member |
| `note_del` | `id` | author or owner |
| `vote` | `id`, `delta` (+1/-1) | any member, limit per person |
| `cursor` | `x` (0..1), `y` (0..10000) | any member, ephemeral |
| `timer` | `action` start/stop, `seconds?` (default 300) | owner |
| `settings` | `anonymous` | owner |

Server to client: `snapshot`, `note_add`, `note_edit`, `note_move`, `note_del`, `votes`, `cursor`, `presence`, `timer`, `settings` (sent as a fresh `snapshot`), `error {code, message}`.

Limits: 4 KB max frame (ws closes with 1009), text frames only (1003), token bucket of 60 burst / 40 per second per connection (excess is dropped with `rate_limited`; 50 violations closes with 1008), 5 sockets per member, 100 per board, ping/pong every 30s with termination of dead sockets.

## Conflict resolution
Server-assigned, strictly increasing timestamps per board (`max(now, last+1)`). Each note carries two: `text_ts` and `pos_ts`, so moving a note never overwrites a concurrent edit and vice versa. The server applies messages in arrival order, so the last to arrive wins and gets the higher timestamp. Clients ignore any incoming `note_edit` / `note_move` whose `ts` is not newer than what they hold, so out-of-order delivery can't regress state.

## DB schema (SQLite, WAL, foreign keys on)

```sql
boards(id PK, name, invite_token UNIQUE, anonymous, vote_limit, timer_end NULL, created_at)
members(id PK, board_id FK, name, token_hash UNIQUE, is_owner, created_at)
notes(id PK AUTOINCREMENT, board_id FK, col CHECK IN (well, improve, actions), text,
      author_id FK, pos REAL, text_ts, pos_ts, created_at)
  INDEX idx_notes_board (board_id, col, pos)
votes(note_id FK, member_id FK, board_id FK, n CHECK n > 0, PRIMARY KEY (note_id, member_id))
  INDEX idx_votes_member (board_id, member_id)
```

All foreign keys cascade. Every note query is scoped by `board_id`, so a guessed note id from another board is `not_found`.

## Client
Vanilla JS, no build. All user content goes through `textContent` (the `el()` helper only creates text nodes). Notes are keyed DOM elements; a note's DOM position is only touched when it actually changes, because moving a focused textarea drops focus. Drag uses the HTML5 API with a drag handle; the drop computes a fractional `pos` between its neighbours. Reconnect uses exponential backoff with jitter, and edits typed while offline are kept as drafts and re-sent after the next snapshot.
