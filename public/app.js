'use strict';

// Everything user-supplied is put on the page via textContent / text nodes
// (see el()), never innerHTML. The CSP backs that up.

const $app = document.getElementById('app');
const COLS = [
  ['well', 'Went well'],
  ['improve', 'Improve'],
  ['actions', 'Actions'],
];

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...kids);
  return e;
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3000);
}

const storeKey = (boardId) => `stickywall:${boardId}`;
const saved = (boardId) => {
  try {
    return JSON.parse(localStorage.getItem(storeKey(boardId)));
  } catch {
    return null;
  }
};

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// --- landing: create a board ------------------------------------------------

function viewLanding() {
  const err = el('div', { class: 'err' });
  const name = el('input', { type: 'text', maxlength: 60, placeholder: 'Sprint 42 retro', required: true });
  const me = el('input', { type: 'text', maxlength: 30, placeholder: 'Your name', required: true });
  const votes = el('input', { type: 'number', min: 1, max: 20, value: 5 });
  const anon = el('input', { type: 'checkbox' });
  const form = el(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const r = await api('/api/boards', {
          name: name.value,
          displayName: me.value,
          voteLimit: Number(votes.value),
          anonymous: anon.checked,
        });
        if (!r.ok) {
          err.textContent = r.status === 429 ? 'Too many boards from this address. Try later.' : 'Check the form and try again.';
          return;
        }
        localStorage.setItem(storeKey(r.data.boardId), JSON.stringify({ session: r.data.session, invite: r.data.invite }));
        location.href = `/b/${r.data.boardId}`;
      },
    },
    el('label', {}, 'Board name'),
    name,
    el('label', {}, 'Your display name'),
    me,
    el('label', {}, 'Votes per person'),
    votes,
    el('label', { class: 'check' }, anon, 'Anonymous notes'),
    el('button', { class: 'primary', type: 'submit' }, 'Create board'),
    err,
  );
  $app.replaceChildren(
    el(
      'div',
      { class: 'panel' },
      el('h1', {}, '📝 Stickywall'),
      el('p', { class: 'hook' }, "Because 'any other business' is never just one business."),
      form,
    ),
  );
}

// --- join via invite --------------------------------------------------------

async function viewJoin(invite) {
  const res = await fetch(`/api/invite/${encodeURIComponent(invite)}`);
  if (!res.ok) {
    $app.replaceChildren(el('div', { class: 'panel' }, el('h1', {}, 'Invite not found'), el('p', {}, 'The link is wrong or the board is gone.')));
    return;
  }
  const { boardName } = await res.json();
  const err = el('div', { class: 'err' });
  const me = el('input', { type: 'text', maxlength: 30, placeholder: 'Your name', required: true });
  $app.replaceChildren(
    el(
      'div',
      { class: 'panel' },
      el('h1', {}, boardName), // textContent via el(): safe
      el('p', { class: 'hook' }, 'Pick a display name to join. No account needed.'),
      el(
        'form',
        {
          onsubmit: async (e) => {
            e.preventDefault();
            const r = await api('/api/join', { invite, displayName: me.value });
            if (!r.ok) {
              err.textContent = r.data.error === 'board_full' ? 'This board is full.' : r.status === 429 ? 'Slow down and retry.' : 'Could not join.';
              return;
            }
            localStorage.setItem(storeKey(r.data.boardId), JSON.stringify({ session: r.data.session }));
            location.href = `/b/${r.data.boardId}`;
          },
        },
        el('label', {}, 'Display name'),
        me,
        el('button', { class: 'primary', type: 'submit' }, 'Join board'),
        err,
      ),
    ),
  );
  me.focus();
}

// --- the board ---------------------------------------------------------------

function viewBoard(boardId) {
  const creds = saved(boardId);
  if (!creds?.session) {
    $app.replaceChildren(el('div', { class: 'panel' }, el('h1', {}, 'Need an invite'), el('p', {}, 'Open the invite link you were sent to join this board.')));
    return;
  }

  const S = {
    ws: null,
    attempt: 0,
    me: null,
    board: null,
    notes: new Map(), // id -> note
    cards: new Map(), // id -> element
    lists: {},
    remaining: 0,
    online: [],
    timer: { endsAt: null, offset: 0 },
    cursors: new Map(),
    drafts: new Map(), // note id -> text not yet acknowledged
    draftTimers: new Map(),
    pendingCid: null,
    ui: null,
  };

  const open = () => S.ws && S.ws.readyState === WebSocket.OPEN;
  const send = (m) => {
    if (!open()) {
      toast('Offline: reconnecting…');
      return false;
    }
    S.ws.send(JSON.stringify(m));
    return true;
  };

  // ----- connection with backoff + jitter -----
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    S.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', session: creds.session }));
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onclose = (ev) => {
      if (S.ws !== ws) return;
      if (S.ui) S.ui.conn.hidden = false;
      if (ev.code === 4001) {
        $app.replaceChildren(el('div', { class: 'panel' }, el('h1', {}, 'Session expired'), el('p', {}, 'Open your invite link again to rejoin.')));
        return;
      }
      const delay = Math.min(15000, 500 * 2 ** S.attempt++) * (0.5 + Math.random() / 2);
      setTimeout(connect, delay);
    };
  }
  const reconnectNow = () => {
    if (S.ws && S.ws.readyState > WebSocket.OPEN) {
      S.attempt = 0;
      connect();
    }
  };
  window.addEventListener('online', reconnectNow);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && reconnectNow());

  // ----- inbound -----
  function onMessage(m) {
    switch (m.t) {
      case 'snapshot':
        return applySnapshot(m);
      case 'note_add': {
        addNote(m.note);
        if (m.cid && m.cid === S.pendingCid) {
          S.pendingCid = null;
          S.cards.get(m.note.id)?.querySelector('textarea')?.focus();
        }
        return;
      }
      case 'note_edit': {
        const n = S.notes.get(m.id);
        // Last write wins by server timestamp: ignore anything older than what we hold.
        if (!n || m.ts <= n.textTs) return;
        n.text = m.text;
        n.textTs = m.ts;
        paintText(n);
        return;
      }
      case 'note_move': {
        const n = S.notes.get(m.id);
        if (!n || m.ts <= n.posTs) return;
        Object.assign(n, { col: m.col, pos: m.pos, posTs: m.ts });
        placeNote(n);
        return;
      }
      case 'note_del':
        return removeNote(m.id);
      case 'votes': {
        const n = S.notes.get(m.id);
        if (!n) return;
        n.votes = m.total;
        if (m.mine !== undefined) {
          n.mine = m.mine;
          S.remaining = m.remaining;
        }
        return paintVotes();
      }
      case 'cursor':
        return moveCursor(m);
      case 'presence':
        S.online = m.online;
        dropGoneCursors();
        return paintHeader();
      case 'timer':
        S.timer = { endsAt: m.endsAt, offset: m.serverNow - Date.now() };
        return;
      case 'error':
        return toast(m.message);
    }
  }

  function applySnapshot(m) {
    S.attempt = 0;
    const firstTime = !S.ui;
    S.me = m.me;
    S.board = m.board;
    S.remaining = m.remaining;
    S.online = m.online;
    S.timer = { endsAt: m.timer.endsAt, offset: m.serverNow - Date.now() };
    document.title = `${m.board.name} · Stickywall`;
    if (firstTime) buildUi();
    S.ui.conn.hidden = true;
    for (const c of S.cards.values()) c.remove();
    S.cards.clear();
    S.notes.clear();
    clearCursors();
    for (const n of m.notes) addNote(n);
    // Re-send edits typed while we were offline; the author's text wins over the snapshot.
    for (const [id, text] of S.drafts) {
      const n = S.notes.get(id);
      if (n && n.own) {
        n.text = text;
        paintText(n);
        send({ t: 'note_edit', id, text });
      }
    }
    S.drafts.clear();
    paintHeader();
    paintVotes();
  }

  // ----- notes -----
  function addNote(n) {
    S.notes.set(n.id, n);
    const card = noteEl(n);
    S.cards.set(n.id, card);
    placeNote(n);
    paintVotes();
  }

  function removeNote(id) {
    S.cards.get(id)?.remove();
    S.cards.delete(id);
    S.notes.delete(id);
    S.drafts.delete(id);
  }

  function placeNote(n) {
    const card = S.cards.get(n.id);
    const list = S.lists[n.col];
    let before = null;
    for (const ch of list.children) {
      if (ch === card) continue;
      const o = S.notes.get(Number(ch.dataset.id));
      if (o.pos > n.pos || (o.pos === n.pos && o.id > n.id)) {
        before = ch;
        break;
      }
    }
    // Only touch the DOM if the position changed: moving a node drops focus.
    if (card.parentNode === list && card.nextElementSibling === before) return;
    list.insertBefore(card, before);
  }

  function paintText(n) {
    const card = S.cards.get(n.id);
    if (!card) return;
    const ta = card.querySelector('textarea');
    if (ta) {
      // Don't clobber what the author is typing right now.
      if (document.activeElement !== ta && !S.drafts.has(n.id)) ta.value = n.text;
      grow(ta);
    } else {
      card.querySelector('.text').textContent = n.text;
    }
  }

  const grow = (ta) => {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  };

  function flushDraft(id) {
    clearTimeout(S.draftTimers.get(id));
    S.draftTimers.delete(id);
    if (!S.drafts.has(id) || !open()) return; // stays queued; resent after reconnect
    send({ t: 'note_edit', id, text: S.drafts.get(id) });
    S.drafts.delete(id);
  }

  let dragId = null;

  function noteEl(n) {
    const card = el('div', { class: 'note', 'data-id': n.id });
    const handle = el('span', { class: 'handle', title: 'Drag to move' }, '⠿');
    handle.addEventListener('mousedown', () => (card.draggable = true));
    handle.addEventListener('mouseup', () => (card.draggable = false));
    card.addEventListener('dragstart', (e) => {
      dragId = n.id;
      e.dataTransfer.setData('text/plain', String(n.id));
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      dragId = null;
      card.draggable = false;
      card.classList.remove('dragging');
      for (const l of Object.values(S.lists)) l.parentNode.classList.remove('over');
    });

    let body;
    if (n.own) {
      body = el('textarea', { maxlength: 500, rows: 1, placeholder: 'Type a note…', 'aria-label': 'Note text' });
      body.value = n.text;
      body.addEventListener('input', () => {
        grow(body);
        S.drafts.set(n.id, body.value);
        clearTimeout(S.draftTimers.get(n.id));
        S.draftTimers.set(n.id, setTimeout(() => flushDraft(n.id), 250));
      });
      body.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          body.blur();
        }
      });
      body.addEventListener('blur', () => {
        flushDraft(n.id);
        if (body.value.trim() === '') send({ t: 'note_del', id: n.id });
      });
      requestAnimationFrame(() => grow(body));
    } else {
      body = el('div', { class: 'text' }, n.text);
    }

    const del = el('button', { class: 'del', title: 'Delete note', 'aria-label': 'Delete note', onclick: () => send({ t: 'note_del', id: n.id }) }, '×');
    del.hidden = !(n.own || S.me.owner);
    const minus = el('button', { class: 'vote minus', title: 'Take back a vote', onclick: () => send({ t: 'vote', id: n.id, delta: -1 }) }, '−');
    const plus = el('button', { class: 'vote plus', title: 'Dot-vote', onclick: () => send({ t: 'vote', id: n.id, delta: 1 }) }, '+');
    const count = el('span', { class: 'count' }, '0');
    const author = el('span', { class: 'author' }, n.author ?? '');
    card.append(handle, body, del, el('div', { class: 'meta' }, author, minus, count, plus));
    return card;
  }

  function paintVotes() {
    for (const n of S.notes.values()) {
      const card = S.cards.get(n.id);
      if (!card) continue;
      card.querySelector('.count').textContent = String(n.votes);
      card.querySelector('.minus').disabled = n.mine < 1;
      card.querySelector('.plus').disabled = S.remaining < 1;
      card.querySelector('.plus').classList.toggle('mine', n.mine > 0);
      card.querySelector('.plus').title = n.mine > 0 ? `You have ${n.mine} here` : 'Dot-vote';
    }
    if (S.ui) {
      const limit = S.board.voteLimit;
      S.ui.dots.textContent = '●'.repeat(Math.max(0, S.remaining)) + '○'.repeat(Math.max(0, limit - S.remaining));
      S.ui.dots.title = `${S.remaining} of ${limit} votes left`;
    }
  }

  // ----- drag & drop target -----
  function wireDropzone(list, col) {
    const wrap = list.parentNode;
    list.addEventListener('dragover', (e) => {
      if (dragId === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      wrap.classList.add('over');
    });
    list.addEventListener('dragleave', (e) => {
      if (!wrap.contains(e.relatedTarget)) wrap.classList.remove('over');
    });
    list.addEventListener('drop', (e) => {
      e.preventDefault();
      wrap.classList.remove('over');
      const n = S.notes.get(dragId);
      if (!n) return;
      const sibs = [...list.children].filter((c) => Number(c.dataset.id) !== n.id);
      const next = sibs.find((c) => {
        const r = c.getBoundingClientRect();
        return e.clientY < r.top + r.height / 2;
      });
      // Neighbours are computed among the *other* cards, so the dragged card
      // itself never counts as its own previous sibling.
      const prev = sibs[(next ? sibs.indexOf(next) : sibs.length) - 1];
      const prevPos = prev ? S.notes.get(Number(prev.dataset.id)).pos : null;
      const nextPos = next ? S.notes.get(Number(next.dataset.id)).pos : null;
      let pos;
      if (prevPos === null && nextPos === null) pos = 1;
      else if (prevPos === null) pos = nextPos - 1;
      else if (nextPos === null) pos = prevPos + 1;
      else pos = (prevPos + nextPos) / 2;
      if (!send({ t: 'note_move', id: n.id, col, pos })) return;
      // Optimistic: the server echo carries the authoritative timestamp.
      Object.assign(n, { col, pos });
      placeNote(n);
    });
  }

  // ----- cursors -----
  const hue = (id) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

  function moveCursor(m) {
    const board = S.ui.board;
    let c = S.cursors.get(m.id);
    if (!c) {
      const label = el('span', {}, m.name ?? 'Someone');
      const node = el('div', { class: 'cursor' }, label);
      node.style.setProperty('--c', `hsl(${hue(m.id)} 65% 42%)`);
      board.append(node);
      S.cursors.set(m.id, (c = { node, label, seen: 0 }));
    }
    c.label.textContent = m.name ?? 'Someone';
    c.seen = Date.now();
    c.node.style.left = `${m.x * board.clientWidth}px`;
    c.node.style.top = `${m.y}px`;
  }
  function dropCursor(id) {
    S.cursors.get(id)?.node.remove();
    S.cursors.delete(id);
  }
  function dropGoneCursors() {
    const here = new Set(S.online.map((o) => o.id));
    for (const id of [...S.cursors.keys()]) if (!here.has(id)) dropCursor(id);
  }
  function clearCursors() {
    for (const id of [...S.cursors.keys()]) dropCursor(id);
  }
  setInterval(() => {
    for (const [id, c] of S.cursors) if (Date.now() - c.seen > 8000) dropCursor(id);
  }, 2000);

  let lastCursorSent = 0;
  document.addEventListener('mousemove', (e) => {
    const now = Date.now();
    if (!S.ui || now - lastCursorSent < 40 || !open()) return;
    lastCursorSent = now;
    const r = S.ui.board.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(10000, Math.max(0, e.clientY - r.top));
    S.ws.send(JSON.stringify({ t: 'cursor', x, y }));
  });

  // ----- UI skeleton -----
  function buildUi() {
    const conn = el('div', { id: 'conn', hidden: true }, 'Connection lost. Reconnecting…');
    const online = el('span', { class: 'pill' });
    const anonPill = el('span', { class: 'pill anon' }, 'Anonymous');
    const anonToggle = el('input', { type: 'checkbox', onchange: (e) => send({ t: 'settings', anonymous: e.target.checked }) });
    const anonLabel = el('label', { class: 'pill' }, anonToggle, ' Anonymous');
    const dots = el('span', { id: 'dots' });
    const timer = el('span', { id: 'timer' }, '5:00');
    const timerBtn = el('button', {}, 'Start 5:00');
    timerBtn.addEventListener('click', () => {
      send(S.timer.endsAt && timeLeft() > 0 ? { t: 'timer', action: 'stop' } : { t: 'timer', action: 'start', seconds: 300 });
    });
    const invite = el('button', {
      onclick: async () => {
        const link = `${location.origin}/join/${creds.invite}`;
        try {
          await navigator.clipboard.writeText(link);
          toast('Invite link copied');
        } catch {
          toast(link); // clipboard blocked (non-secure origin): show it to copy by hand
        }
      },
    }, 'Copy invite link');
    const exp = el('button', { onclick: exportMd }, 'Export .md');
    const title = el('h1', {});
    const header = el('header', { class: 'top' }, title, online, anonPill, anonLabel, el('span', { class: 'spacer' }), dots, timer, timerBtn, invite, exp);

    const board = el('div', { id: 'board' });
    for (const [key, label] of COLS) {
      const list = el('div', { class: 'notes' });
      const add = el('button', {
        title: 'Add a note',
        onclick: () => {
          S.pendingCid = Math.random().toString(16).slice(2, 10);
          send({ t: 'note_add', col: key, text: '', cid: S.pendingCid });
        },
      }, '+');
      const col = el('section', { class: 'col', 'data-col': key }, el('h2', {}, label, add), list);
      board.append(col);
      S.lists[key] = list;
      wireDropzone(list, key);
    }
    $app.replaceChildren(conn, header, board);
    S.ui = { conn, online, anonPill, anonLabel, anonToggle, dots, timer, timerBtn, invite, title, board };
    setInterval(paintTimer, 250);
  }

  function paintHeader() {
    const u = S.ui;
    u.title.textContent = S.board.name;
    const named = S.online.map((o) => o.name ?? 'Anonymous');
    u.online.textContent = `${S.online.length} online`;
    u.online.title = named.join(', ');
    u.anonPill.hidden = !S.board.anonymous || S.me.owner;
    u.anonLabel.hidden = !S.me.owner;
    u.anonToggle.checked = S.board.anonymous;
    u.timerBtn.hidden = !S.me.owner;
    u.invite.hidden = !(S.me.owner && creds.invite);
  }

  const timeLeft = () => S.timer.endsAt - (Date.now() + S.timer.offset);

  function paintTimer() {
    const u = S.ui;
    if (!u) return;
    if (!S.timer.endsAt) {
      u.timer.textContent = '5:00';
      u.timer.className = '';
      u.timerBtn.textContent = 'Start 5:00';
      return;
    }
    const left = timeLeft();
    if (left <= 0) {
      u.timer.textContent = "Time's up";
      u.timer.className = 'done';
      u.timerBtn.textContent = 'Restart 5:00';
      return;
    }
    const s = Math.ceil(left / 1000);
    u.timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    u.timer.className = s <= 30 ? 'low' : '';
    u.timerBtn.textContent = 'Stop';
  }

  async function exportMd() {
    const res = await fetch(`/api/boards/${boardId}/export.md`, { headers: { authorization: `Bearer ${creds.session}` } });
    if (!res.ok) return toast('Export failed');
    const url = URL.createObjectURL(await res.blob());
    const a = el('a', { href: url, download: `${S.board.name.replace(/[^\w-]+/g, '_') || 'retro'}.md` });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  connect();
}

// --- router -------------------------------------------------------------------

const path = location.pathname;
let match;
if ((match = path.match(/^\/join\/([\w-]+)$/))) viewJoin(match[1]);
else if ((match = path.match(/^\/b\/([0-9a-f]+)$/))) viewBoard(match[1]);
else viewLanding();
