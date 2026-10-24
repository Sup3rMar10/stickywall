import { WebSocketServer } from 'ws';
import { validateMessage } from './validate.js';
import { TokenBucket } from './ratelimit.js';
import { MAX_NOTES } from './store.js';

export const MAX_PAYLOAD = 4096; // bytes; a 500-char note is at most ~2KB of UTF-8
const AUTH_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 30_000;
const MAX_BUFFERED = 1_000_000;
const MAX_CONNS_PER_MEMBER = 5;
const MAX_CONNS_PER_BOARD = 100;
const MAX_VIOLATIONS = 50;

class Client {
  constructor(ws) {
    this.ws = ws;
    this.alive = true;
    this.member = null; // set after auth
    this.room = null;
    this.bucket = new TokenBucket(60, 40); // burst 60, then 40 msg/s
    this.violations = 0;
  }

  get memberId() {
    return this.member?.memberId;
  }

  send(obj) {
    const ws = this.ws;
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED) return ws.terminate(); // slow consumer
    ws.send(JSON.stringify(obj));
  }

  fail(code, message) {
    this.send({ t: 'error', code, message });
  }
}

// Wire shape of a note for one viewer. Authors are stripped server-side in
// anonymous mode; `own` tells the client which notes it may edit.
function wireNote(n, viewerId, anonymous) {
  return {
    id: n.id,
    col: n.col,
    text: n.text,
    pos: n.pos,
    textTs: n.textTs,
    posTs: n.posTs,
    votes: n.votes,
    mine: n.mine ?? 0,
    own: n.authorId === viewerId,
    author: anonymous ? null : n.authorName,
  };
}

class Room {
  constructor(id, { store, bus }) {
    this.id = id;
    this.store = store;
    this.clients = new Set();
    const b = store.board(id);
    this.state = { name: b.name, anonymous: b.anonymous, voteLimit: b.voteLimit, timerEnd: b.timerEnd };
    this.unsubscribe = bus.subscribe(id, (ev) => this.dispatch(ev));
  }

  online(client) {
    const seen = new Map();
    for (const c of this.clients) seen.set(c.memberId, c.member.name);
    return [...seen].map(([id, name]) => ({ id, name: this.state.anonymous && id !== client.memberId ? null : name }));
  }

  snapshot(client) {
    const s = this.state;
    return {
      t: 'snapshot',
      board: { id: this.id, name: s.name, anonymous: s.anonymous, voteLimit: s.voteLimit },
      me: { id: client.memberId, name: client.member.name, owner: client.member.isOwner },
      notes: this.store.notes(this.id, client.memberId).map((n) => wireNote(n, client.memberId, s.anonymous)),
      remaining: this.store.votesRemaining(this.id, client.memberId, s.voteLimit),
      timer: { endsAt: s.timerEnd },
      serverNow: Date.now(),
      online: this.online(client),
    };
  }

  // Events on the bus are raw: they carry author ids and are the same for every
  // recipient. Rendering per client happens here, on the node holding the socket.
  dispatch(ev) {
    if (ev.type === 'settings') this.state.anonymous = ev.anonymous;
    if (ev.type === 'timer') this.state.timerEnd = ev.endsAt;
    for (const c of this.clients) {
      const msg = this.render(ev, c);
      if (msg) c.send(msg);
    }
  }

  render(ev, c) {
    const anon = this.state.anonymous;
    switch (ev.type) {
      case 'note_add':
        return {
          t: 'note_add',
          cid: ev.by === c.memberId ? ev.cid : undefined,
          note: wireNote({ ...ev.note, mine: 0 }, c.memberId, anon),
        };
      case 'note_edit':
        return { t: 'note_edit', id: ev.id, text: ev.text, ts: ev.ts };
      case 'note_move':
        return { t: 'note_move', id: ev.id, col: ev.col, pos: ev.pos, ts: ev.ts };
      case 'note_del':
        return { t: 'note_del', id: ev.id };
      case 'votes': {
        const out = { t: 'votes', id: ev.id, total: ev.total };
        if (ev.by === c.memberId) Object.assign(out, { mine: ev.mine, remaining: ev.remaining });
        return out;
      }
      case 'cursor':
        if (ev.by === c.memberId) return null;
        return { t: 'cursor', id: ev.by, name: anon ? null : ev.name, x: ev.x, y: ev.y };
      case 'presence':
        return { t: 'presence', online: this.online(c) };
      case 'timer':
        return { t: 'timer', endsAt: ev.endsAt, serverNow: Date.now() };
      case 'settings':
        return this.snapshot(c); // anonymity changed: re-send everything, re-stripped
      default:
        return null;
    }
  }
}

export function attachWs({ server, store, bus, log = () => {} }) {
  const rooms = new Map();

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: MAX_PAYLOAD, // ws closes the socket with 1009 above this
    verifyClient: ({ origin, req }, done) => {
      // Browsers always send Origin on WebSocket upgrades. A page on another
      // site must not be able to open a socket to us from a visitor's browser.
      if (origin) {
        let ok = false;
        try {
          ok = new URL(origin).host === req.headers.host;
        } catch {}
        if (!ok) return done(false, 403, 'bad origin');
      }
      done(true);
    },
  });

  const publish = (boardId, ev) => bus.publish(boardId, ev);

  const handlers = {
    note_add(c, m) {
      if (store.noteCount(c.room.id) >= MAX_NOTES) return c.fail('board_full', 'Too many notes on this board');
      const note = store.addNote(c.room.id, c.memberId, m.col, m.text);
      publish(c.room.id, { type: 'note_add', note, cid: m.cid, by: c.memberId });
    },

    note_edit(c, m) {
      const note = store.note(c.room.id, m.id);
      if (!note) return c.fail('not_found', 'Note not found');
      if (note.authorId !== c.memberId) return c.fail('forbidden', 'You can only edit your own notes');
      const ts = store.editNote(c.room.id, m.id, m.text);
      publish(c.room.id, { type: 'note_edit', id: m.id, text: m.text, ts });
    },

    note_move(c, m) {
      if (!store.note(c.room.id, m.id)) return c.fail('not_found', 'Note not found');
      const ts = store.moveNote(c.room.id, m.id, m.col, m.pos);
      publish(c.room.id, { type: 'note_move', id: m.id, col: m.col, pos: m.pos, ts });
    },

    note_del(c, m) {
      const note = store.note(c.room.id, m.id);
      if (!note) return c.fail('not_found', 'Note not found');
      if (note.authorId !== c.memberId && !c.member.isOwner) return c.fail('forbidden', 'Not your note');
      store.deleteNote(c.room.id, m.id);
      publish(c.room.id, { type: 'note_del', id: m.id });
    },

    vote(c, m) {
      if (!store.note(c.room.id, m.id)) return c.fail('not_found', 'Note not found');
      const r = store.vote(c.room.id, m.id, c.memberId, m.delta, c.room.state.voteLimit);
      if (r.error) {
        return c.fail(r.error, r.error === 'vote_limit' ? 'You are out of votes' : 'You have no vote on this note');
      }
      publish(c.room.id, { type: 'votes', id: m.id, by: c.memberId, ...r });
    },

    cursor(c, m) {
      publish(c.room.id, { type: 'cursor', by: c.memberId, name: c.member.name, x: m.x, y: m.y });
    },

    timer(c, m) {
      if (!c.member.isOwner) return c.fail('forbidden', 'Only the facilitator controls the timer');
      const endsAt = m.action === 'start' ? Date.now() + (m.seconds ?? 300) * 1000 : null;
      store.setTimer(c.room.id, endsAt);
      publish(c.room.id, { type: 'timer', endsAt });
    },

    settings(c, m) {
      if (!c.member.isOwner) return c.fail('forbidden', 'Only the facilitator can change settings');
      store.setAnonymous(c.room.id, m.anonymous);
      publish(c.room.id, { type: 'settings', anonymous: m.anonymous });
    },
  };

  function authenticate(c, m) {
    const member = store.memberBySession(m.session);
    if (!member) {
      c.fail('unauthorized', 'Invalid session');
      return c.ws.close(4001, 'unauthorized');
    }
    let room = rooms.get(member.boardId);
    if (!room) rooms.set(member.boardId, (room = new Room(member.boardId, { store, bus })));
    const mine = [...room.clients].filter((x) => x.memberId === member.memberId).length;
    if (room.clients.size >= MAX_CONNS_PER_BOARD || mine >= MAX_CONNS_PER_MEMBER) {
      c.fail('too_many_connections', 'Too many connections');
      if (room.clients.size === 0) {
        room.unsubscribe();
        rooms.delete(room.id);
      }
      return c.ws.close(4008, 'too many connections');
    }
    c.member = member;
    c.room = room;
    room.clients.add(c);
    c.send(room.snapshot(c));
    publish(room.id, { type: 'presence' });
  }

  function leave(c) {
    const room = c.room;
    if (!room) return;
    room.clients.delete(c);
    c.room = null;
    if (room.clients.size === 0) {
      room.unsubscribe();
      rooms.delete(room.id);
    } else {
      publish(room.id, { type: 'presence' });
    }
  }

  wss.on('connection', (ws) => {
    const c = new Client(ws);
    // Unauthenticated sockets get a few seconds to say who they are.
    const authTimer = setTimeout(() => c.member || ws.close(4001, 'auth timeout'), AUTH_TIMEOUT_MS);

    ws.on('pong', () => (c.alive = true));
    ws.on('error', (e) => log('ws error', e.message));

    ws.on('message', (data, isBinary) => {
      if (isBinary) return ws.close(1003, 'text only');
      if (!c.bucket.take()) {
        c.fail('rate_limited', 'Slow down');
        if (++c.violations > MAX_VIOLATIONS) ws.close(1008, 'rate limit');
        return;
      }
      const r = validateMessage(data.toString('utf8'));
      if (!r.ok) {
        log('invalid message:', r.reason);
        return c.fail('invalid', 'Invalid message');
      }
      const m = r.msg;
      if (!c.member) {
        if (m.t !== 'auth') return ws.close(4001, 'auth required');
        return authenticate(c, m);
      }
      if (m.t === 'auth') return c.fail('invalid', 'Already authenticated');
      try {
        handlers[m.t](c, m);
      } catch (e) {
        log('handler error', m.t, e);
        c.fail('server_error', 'Something went wrong');
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      leave(c);
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of allClients()) {
      if (!client.alive) {
        client.ws.terminate();
        continue;
      }
      client.alive = false;
      client.ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  function* allClients() {
    for (const room of rooms.values()) yield* room.clients;
  }

  return {
    wss,
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
