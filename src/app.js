import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { LocalBus } from './bus.js';
import { attachWs } from './ws.js';
import { KeyedLimiter } from './ratelimit.js';
import { cleanText, MAX_NAME } from './validate.js';
import { exportMarkdown } from './markdown.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Notes are rendered with textContent only, and this CSP is the second layer:
// no inline script, no external anything, so an injected tag can't run or phone home.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function boardInput(body) {
  if (body === null || typeof body !== 'object') return null;
  const { name, displayName, voteLimit = 5, anonymous = false } = body;
  if (typeof name !== 'string' || typeof displayName !== 'string') return null;
  const n = cleanText(name);
  const d = cleanText(displayName);
  if (n.length < 1 || n.length > 60 || d.length < 1 || d.length > MAX_NAME) return null;
  if (!Number.isInteger(voteLimit) || voteLimit < 1 || voteLimit > 20) return null;
  if (typeof anonymous !== 'boolean') return null;
  return { name: n, displayName: d, voteLimit, anonymous };
}

// ipLimits: [burst, refill per second] for board creation and invite/join, per client IP.
export function createApp({
  dbPath = ':memory:',
  log = () => {},
  ipLimits = { create: [10, 10 / 600], join: [30, 10 / 600] },
} = {}) {
  const store = new Store(dbPath);
  const bus = new LocalBus();
  const app = express();
  const server = http.createServer(app);
  const createLimit = new KeyedLimiter(...ipLimits.create);
  const joinLimit = new KeyedLimiter(...ipLimits.join);

  const limit = (limiter) => (req, res, next) =>
    limiter.allow(req.ip) ? next() : res.status(429).json({ error: 'rate_limited' });

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      // Invite tokens live in the URL path, so never leak them via Referer.
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });
  app.use(express.json({ limit: '4kb' }));

  app.post('/api/boards', limit(createLimit), (req, res) => {
    const input = boardInput(req.body);
    if (!input) return res.status(400).json({ error: 'invalid' });
    res.status(201).json(store.createBoard(input));
  });

  app.get('/api/invite/:token', limit(joinLimit), (req, res) => {
    const info = store.inviteInfo(req.params.token);
    if (!info) return res.status(404).json({ error: 'bad_invite' });
    res.json({ boardName: info.name });
  });

  app.post('/api/join', limit(joinLimit), (req, res) => {
    const { invite, displayName } = req.body ?? {};
    if (typeof invite !== 'string' || invite.length > 64 || typeof displayName !== 'string') {
      return res.status(400).json({ error: 'invalid' });
    }
    const name = cleanText(displayName);
    if (name.length < 1 || name.length > MAX_NAME) return res.status(400).json({ error: 'invalid' });
    const r = store.join(invite, name);
    if (r.error === 'bad_invite') return res.status(404).json(r);
    if (r.error) return res.status(409).json(r);
    res.status(201).json(r);
  });

  app.get('/api/boards/:id/export.md', (req, res) => {
    const m = /^Bearer (\S{10,128})$/.exec(req.get('authorization') ?? '');
    const member = m && store.memberBySession(m[1]);
    // Same answer for "no such board" and "not your board".
    if (!member || member.boardId !== req.params.id) return res.status(401).json({ error: 'unauthorized' });
    const board = store.board(member.boardId);
    const notes = store.notes(member.boardId, member.memberId);
    res.set({
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="retro-${member.boardId}.md"`,
      'Cache-Control': 'no-store',
    });
    res.send(exportMarkdown({ board, notes }));
  });

  app.use(express.static(PUBLIC_DIR, { index: false }));
  const page = (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  app.get(['/', '/join/:token', '/b/:id'], page);

  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return res.status(400).json({ error: 'invalid' });
    }
    log('http error', err);
    res.status(500).json({ error: 'server_error' });
  });

  const ws = attachWs({ server, store, bus, log });

  return {
    server,
    store,
    close() {
      ws.close();
      createLimit.close();
      joinLimit.close();
      server.close();
      server.closeAllConnections?.();
      store.close();
    },
  };
}
