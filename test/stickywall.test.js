import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import { validateMessage } from '../src/validate.js';
import { escapeMd } from '../src/markdown.js';

let app, base, wsBase;

before(async () => {
  app = createApp({ dbPath: ':memory:', ipLimits: { create: [1000, 100], join: [1000, 100] } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const { port } = app.server.address();
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}/ws`;
});
after(() => app.close());

const post = (path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function newBoard(opts = {}) {
  const r = await post('/api/boards', { name: 'Sprint 12', displayName: 'Owner', voteLimit: 3, ...opts });
  assert.equal(r.status, 201);
  return r.json();
}

async function joinBoard(invite, displayName) {
  const r = await post('/api/join', { invite, displayName });
  assert.equal(r.status, 201);
  return r.json();
}

// Minimal WS test client: buffers messages, lets tests await one by predicate.
function connect(session, { auth = true, headers } = {}) {
  const ws = new WebSocket(wsBase, { headers });
  const queue = [];
  const waiters = [];
  const closed = new Promise((r) => ws.on('close', (code) => r(code)));
  ws.on('message', (d) => {
    const msg = JSON.parse(d.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  const c = {
    ws,
    closed,
    send: (o) => ws.send(typeof o === 'string' ? o : JSON.stringify(o)),
    next(pred = () => true, ms = 2000) {
      const i = queue.findIndex(pred);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => {
          const j = waiters.indexOf(w);
          if (j >= 0) {
            waiters.splice(j, 1);
            reject(new Error('timed out waiting for message'));
          }
        }, ms);
      });
    },
    type: (t) => c.next((m) => m.t === t),
    drain: () => queue.splice(0),
  };
  return new Promise((resolve, reject) => {
    ws.on('open', async () => {
      if (auth) {
        c.send({ t: 'auth', session });
        c.snapshot = await c.type('snapshot');
      }
      resolve(c);
    });
    ws.on('unexpected-response', (req, res) => reject(Object.assign(new Error('rejected'), { status: res.statusCode })));
    ws.on('error', () => {});
  });
}

test('create, invite, join and receive a snapshot', async () => {
  const b = await newBoard();
  const guest = await joinBoard(b.invite, 'Guest');
  assert.equal(guest.boardId, b.boardId);
  const o = await connect(b.session);
  assert.equal(o.snapshot.me.owner, true);
  assert.equal(o.snapshot.board.name, 'Sprint 12');
  assert.equal(o.snapshot.remaining, 3);
  const g = await connect(guest.session);
  assert.equal(g.snapshot.me.owner, false);
  const presence = await o.next((m) => m.t === 'presence' && m.online.length === 2);
  assert.deepEqual(presence.online.map((p) => p.name).sort(), ['Guest', 'Owner']);
  o.ws.close();
  g.ws.close();
});

test('bad invite and invalid board input are rejected', async () => {
  assert.equal((await post('/api/join', { invite: 'nope', displayName: 'x' })).status, 404);
  assert.equal((await post('/api/join', { invite: 5, displayName: 'x' })).status, 400);
  assert.equal((await post('/api/boards', { name: '', displayName: 'a' })).status, 400);
  assert.equal((await post('/api/boards', { name: 'a', displayName: 'a', voteLimit: 99 })).status, 400);
  assert.equal((await post('/api/boards', { name: 'a', displayName: 'a', anonymous: 'yes' })).status, 400);
  const r = await fetch(base + '/api/boards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(r.status, 400);
});

test('websocket auth: wrong session, non-auth first message, bad origin', async () => {
  const bad = await connect('x'.repeat(40), { auth: false });
  bad.send({ t: 'auth', session: 'x'.repeat(40) });
  assert.equal((await bad.type('error')).code, 'unauthorized');
  assert.equal(await bad.closed, 4001);

  const sneaky = await connect(null, { auth: false });
  sneaky.send({ t: 'cursor', x: 0.5, y: 10 });
  assert.equal(await sneaky.closed, 4001);

  await assert.rejects(connect(null, { auth: false, headers: { Origin: 'http://evil.example' } }), { status: 403 });
});

test('notes: add, edit, move; server timestamps strictly increase', async () => {
  const b = await newBoard();
  const o = await connect(b.session);
  o.send({ t: 'note_add', col: 'well', text: 'Shipped on time', cid: 'c1' });
  const added = await o.type('note_add');
  assert.equal(added.cid, 'c1');
  assert.equal(added.note.own, true);
  const id = added.note.id;

  o.send({ t: 'note_edit', id, text: 'Shipped on time!' });
  const e = await o.type('note_edit');
  o.send({ t: 'note_move', id, col: 'actions', pos: 7.5 });
  const mv = await o.type('note_move');
  assert.ok(e.ts > added.note.textTs);
  assert.ok(mv.ts > e.ts);
  assert.equal(mv.col, 'actions');

  const again = await connect(b.session);
  const n = again.snapshot.notes.find((x) => x.id === id);
  assert.equal(n.text, 'Shipped on time!');
  assert.equal(n.col, 'actions');
  assert.equal(n.pos, 7.5);
  o.ws.close();
  again.ws.close();
});

test('last write wins: two clients move one note, later arrival wins everywhere', async () => {
  const b = await newBoard();
  const g = await joinBoard(b.invite, 'Guest');
  const o = await connect(b.session);
  const c = await connect(g.session);
  o.send({ t: 'note_add', col: 'well', text: 'contested' });
  const id = (await o.type('note_add')).note.id;
  await c.type('note_add');

  o.send({ t: 'note_move', id, col: 'improve', pos: 1 });
  c.send({ t: 'note_move', id, col: 'actions', pos: 2 });
  const seen = [await o.type('note_move'), await o.type('note_move')];
  assert.ok(seen[1].ts > seen[0].ts);
  const final = seen[1];
  // A fresh snapshot agrees with the last move the server processed.
  const fresh = await connect(b.session);
  const n = fresh.snapshot.notes.find((x) => x.id === id);
  assert.equal(n.col, final.col);
  assert.equal(n.posTs, final.ts);
  for (const x of [o, c, fresh]) x.ws.close();
});

test('permissions: only authors edit, authors or owner delete, owner runs timer and settings', async () => {
  const b = await newBoard();
  const g = await joinBoard(b.invite, 'Guest');
  const o = await connect(b.session);
  const c = await connect(g.session);

  o.send({ t: 'note_add', col: 'improve', text: 'owner note' });
  const ownerNote = (await o.type('note_add')).note.id;
  c.send({ t: 'note_add', col: 'improve', text: 'guest note' });
  const guestNote = (await c.type('note_add')).note.id;
  await o.type('note_add');

  c.send({ t: 'note_edit', id: ownerNote, text: 'hijack' });
  assert.equal((await c.type('error')).code, 'forbidden');
  c.send({ t: 'note_del', id: ownerNote });
  assert.equal((await c.type('error')).code, 'forbidden');
  c.send({ t: 'timer', action: 'start' });
  assert.equal((await c.type('error')).code, 'forbidden');
  c.send({ t: 'settings', anonymous: true });
  assert.equal((await c.type('error')).code, 'forbidden');

  o.send({ t: 'note_del', id: guestNote }); // owner may delete any note
  assert.equal((await c.type('note_del')).id, guestNote);
  for (const x of [o, c]) x.ws.close();
});

test('another board cannot touch a note by guessing its id', async () => {
  const a = await newBoard();
  const b = await newBoard();
  const oa = await connect(a.session);
  const ob = await connect(b.session);
  oa.send({ t: 'note_add', col: 'well', text: 'a-note' });
  const id = (await oa.type('note_add')).note.id;
  ob.send({ t: 'note_move', id, col: 'actions', pos: 1 });
  assert.equal((await ob.type('error')).code, 'not_found');
  ob.send({ t: 'note_del', id });
  assert.equal((await ob.type('error')).code, 'not_found');
  oa.ws.close();
  ob.ws.close();
});

test('dot voting enforces the per-person limit and supports taking votes back', async () => {
  const b = await newBoard({ voteLimit: 3 });
  const o = await connect(b.session);
  o.send({ t: 'note_add', col: 'well', text: 'a' });
  const n1 = (await o.type('note_add')).note.id;
  o.send({ t: 'note_add', col: 'well', text: 'b' });
  const n2 = (await o.type('note_add')).note.id;

  for (let i = 0; i < 2; i++) o.send({ t: 'vote', id: n1, delta: 1 });
  o.send({ t: 'vote', id: n2, delta: 1 });
  let v;
  for (let i = 0; i < 3; i++) v = await o.type('votes');
  assert.equal(v.remaining, 0);

  o.send({ t: 'vote', id: n2, delta: 1 });
  assert.equal((await o.type('error')).code, 'vote_limit');
  o.send({ t: 'vote', id: n2, delta: -1 });
  const back = await o.type('votes');
  assert.equal(back.total, 0);
  assert.equal(back.remaining, 1);
  o.send({ t: 'vote', id: n2, delta: -1 });
  assert.equal((await o.type('error')).code, 'no_vote');

  const fresh = await connect(b.session);
  assert.equal(fresh.snapshot.remaining, 1);
  assert.equal(fresh.snapshot.notes.find((x) => x.id === n1).mine, 2);
  o.ws.close();
  fresh.ws.close();
});

test('anonymous mode strips authors server-side; toggling re-sends snapshots', async () => {
  const b = await newBoard({ anonymous: true });
  const g = await joinBoard(b.invite, 'Guest');
  const o = await connect(b.session);
  const c = await connect(g.session);
  c.send({ t: 'note_add', col: 'well', text: 'secret feedback' });
  const live = await o.type('note_add');
  assert.equal(live.note.author, null);
  assert.equal(live.note.own, false);
  assert.ok(!JSON.stringify(live).includes('Guest'));
  assert.equal((await c.type('note_add')).note.own, true);

  const fresh = await connect(b.session);
  assert.ok(!JSON.stringify(fresh.snapshot).includes('Guest'));
  c.send({ t: 'cursor', x: 0.1, y: 5 });
  const cur = await o.type('cursor');
  assert.equal(cur.name, null);

  o.send({ t: 'settings', anonymous: false });
  const snap = await o.next((m) => m.t === 'snapshot');
  assert.equal(snap.board.anonymous, false);
  assert.equal(snap.notes[0].author, 'Guest');
  for (const x of [o, c, fresh]) x.ws.close();
});

test('timer is stored on the server and broadcast with its clock', async () => {
  const b = await newBoard();
  const g = await joinBoard(b.invite, 'Guest');
  const o = await connect(b.session);
  const c = await connect(g.session);
  const before = Date.now();
  o.send({ t: 'timer', action: 'start' });
  const t = await c.type('timer');
  assert.ok(Math.abs(t.endsAt - (before + 300_000)) < 2000);
  assert.ok(Math.abs(t.serverNow - Date.now()) < 2000);
  const late = await connect(g.session); // joins mid-countdown
  assert.equal(late.snapshot.timer.endsAt, t.endsAt);
  o.send({ t: 'timer', action: 'stop' });
  assert.equal((await c.type('timer')).endsAt, null);
  for (const x of [o, c, late]) x.ws.close();
});

test('validation: schema, size and type limits', async () => {
  const b = await newBoard();
  const o = await connect(b.session);
  const bad = [
    'not json',
    '[]',
    'null',
    { t: 'nope' },
    { t: 'toString' },
    { t: 'note_add', col: 'well', text: 'x'.repeat(501) },
    { t: 'note_add', col: 'bogus', text: 'x' },
    { t: 'note_add', col: 'well', text: 'x', extra: 1 },
    { t: 'note_add', col: 'well', text: 42 },
    { t: 'note_move', id: 1.5, col: 'well', pos: 1 },
    { t: 'note_move', id: 1, col: 'well', pos: null },
    { t: 'vote', id: 1, delta: 2 },
    { t: 'cursor', x: 2, y: 0 },
    { t: 'cursor', x: 0.5, y: -1 },
    { t: 'timer', action: 'start', seconds: 99999 },
    { t: 'auth', session: 'y'.repeat(40) },
  ];
  for (const m of bad) {
    o.send(m);
    assert.equal((await o.type('error')).code, 'invalid', JSON.stringify(m).slice(0, 60));
  }
  // Still alive and working afterwards.
  o.send({ t: 'note_add', col: 'well', text: 'x'.repeat(500) });
  assert.equal((await o.type('note_add')).note.text.length, 500);
  o.ws.close();
});

test('oversized frame closes the connection (1009)', async () => {
  const b = await newBoard();
  const o = await connect(b.session);
  o.send(JSON.stringify({ t: 'note_add', col: 'well', text: 'x'.repeat(8000) }));
  assert.equal(await o.closed, 1009);
});

test('binary frames are refused', async () => {
  const b = await newBoard();
  const o = await connect(b.session);
  o.ws.send(Buffer.from([1, 2, 3]));
  assert.equal(await o.closed, 1003);
});

test('per-connection rate limit drops floods, then disconnects persistent abusers', async () => {
  const b = await newBoard();
  const o = await connect(b.session);
  for (let i = 0; i < 400; i++) o.send({ t: 'cursor', x: 0.5, y: 1 });
  const err = await o.next((m) => m.t === 'error' && m.code === 'rate_limited');
  assert.ok(err);
  assert.equal(await o.closed, 1008);
});

test('control characters and bidi overrides are stripped from text', () => {
  const r = validateMessage(JSON.stringify({ t: 'note_add', col: 'well', text: 'a\u0000b‮c\u0007d' }));
  assert.equal(r.msg.text, 'abcd');
  const multi = validateMessage(JSON.stringify({ t: 'note_add', col: 'well', text: 'line1\nline2' }));
  assert.equal(multi.msg.text, 'line1\nline2');
});

test('XSS payloads are stored and returned as inert text, with CSP on the page', async () => {
  const b = await newBoard();
  const o = await connect(b.session);
  const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  o.send({ t: 'note_add', col: 'well', text: payload });
  assert.equal((await o.type('note_add')).note.text, payload); // data is untouched; rendering uses textContent
  const page = await fetch(base + '/');
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  o.ws.close();
});

test('markdown export: auth required, content escaped, authors hidden when anonymous', async () => {
  const b = await newBoard();
  const other = await newBoard();
  const o = await connect(b.session);
  o.send({ t: 'note_add', col: 'well', text: '# Heading\n- [click](http://evil.example) *bold*' });
  await o.type('note_add');
  o.send({ t: 'note_add', col: 'actions', text: 'Write docs' });
  const actionId = (await o.type('note_add')).note.id;
  o.send({ t: 'vote', id: actionId, delta: 1 });
  await o.type('votes');

  const url = `${base}/api/boards/${b.boardId}/export.md`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${other.session}` } })).status, 401);

  const res = await fetch(url, { headers: { authorization: `Bearer ${b.session}` } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/markdown/);
  const md = await res.text();
  assert.match(md, /^# Sprint 12$/m);
  assert.match(md, /^## Went well$/m);
  assert.doesNotMatch(md, /^# Heading/m); // note text can't create a heading
  assert.match(md, /\\\[click\\\]/); // link syntax escaped
  assert.match(md, /^- \[ \] Write docs _\(1 vote\)_ — Owner$/m);

  o.send({ t: 'settings', anonymous: true });
  await o.next((m) => m.t === 'snapshot');
  const anon = await (await fetch(url, { headers: { authorization: `Bearer ${b.session}` } })).text();
  assert.doesNotMatch(anon, /Owner/);
  o.ws.close();
});

test('escapeMd flattens newlines and escapes inline syntax', () => {
  assert.equal(escapeMd('a\n# b'), 'a \\# b');
  assert.equal(escapeMd('`x` <b>'), '\\`x\\` \\<b\\>');
});

test('reconnect: a new socket gets full current state', async () => {
  const b = await newBoard();
  const o = await connect(b.session);
  o.send({ t: 'note_add', col: 'well', text: 'persisted' });
  await o.type('note_add');
  o.ws.terminate(); // simulate a dropped connection, no clean close
  await o.closed;
  const o2 = await connect(b.session);
  assert.equal(o2.snapshot.notes.length, 1);
  assert.equal(o2.snapshot.notes[0].text, 'persisted');
  assert.equal(o2.snapshot.notes[0].own, true);
  o2.ws.close();
});

test('live cursors reach other clients but not the sender', async () => {
  const b = await newBoard();
  const g = await joinBoard(b.invite, 'Guest');
  const o = await connect(b.session);
  const c = await connect(g.session);
  o.send({ t: 'cursor', x: 0.25, y: 120 });
  const cur = await c.type('cursor');
  assert.deepEqual([cur.x, cur.y, cur.name], [0.25, 120, 'Owner']);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(o.drain().filter((m) => m.t === 'cursor').length, 0);
  o.ws.close();
  c.ws.close();
});

test('HTTP create/join endpoints are rate limited per IP', async () => {
  const limited = createApp({ ipLimits: { create: [3, 0.001], join: [3, 0.001] } });
  await new Promise((r) => limited.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${limited.server.address().port}/api/boards`;
  const statuses = [];
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'b', displayName: 'o' }),
    });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses, [201, 201, 201, 429, 429]);
  limited.close();
});
