import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { COLS } from './validate.js';

export const MAX_MEMBERS = 50;
export const MAX_NOTES = 300;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randHex = (n) => crypto.randomBytes(n).toString('hex');
const randToken = (n) => crypto.randomBytes(n).toString('base64url');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS boards(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  invite_token TEXT NOT NULL UNIQUE,
  anonymous INTEGER NOT NULL DEFAULT 0,
  vote_limit INTEGER NOT NULL DEFAULT 5,
  timer_end INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members(
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  is_owner INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_members_board ON members(board_id);
CREATE TABLE IF NOT EXISTS notes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  col TEXT NOT NULL CHECK (col IN ('${COLS.join("','")}')),
  text TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  pos REAL NOT NULL,
  text_ts INTEGER NOT NULL,
  pos_ts INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_board ON notes(board_id, col, pos);
CREATE TABLE IF NOT EXISTS votes(
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  n INTEGER NOT NULL CHECK (n > 0),
  PRIMARY KEY (note_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_votes_member ON votes(board_id, member_id);
`;

const NOTE_SELECT = `
SELECT n.id, n.col, n.text, n.pos, n.text_ts AS textTs, n.pos_ts AS posTs,
       n.author_id AS authorId, m.name AS authorName,
       COALESCE((SELECT SUM(v.n) FROM votes v WHERE v.note_id = n.id), 0) AS votes,
       COALESCE((SELECT v.n FROM votes v WHERE v.note_id = n.id AND v.member_id = :viewer), 0) AS mine
FROM notes n JOIN members m ON m.id = n.author_id`;

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    this.db.exec(SCHEMA);
    this.lastTs = new Map(); // boardId -> last timestamp handed out
    const p = (sql) => this.db.prepare(sql);
    this.q = {
      insertBoard: p('INSERT INTO boards(id, name, invite_token, anonymous, vote_limit, created_at) VALUES(?,?,?,?,?,?)'),
      insertMember: p('INSERT INTO members(id, board_id, name, token_hash, is_owner, created_at) VALUES(?,?,?,?,?,?)'),
      boardByInvite: p('SELECT id, name FROM boards WHERE invite_token = ?'),
      board: p('SELECT id, name, anonymous, vote_limit AS voteLimit, timer_end AS timerEnd FROM boards WHERE id = ?'),
      memberCount: p('SELECT COUNT(*) AS c FROM members WHERE board_id = ?'),
      memberBySession: p(
        'SELECT id AS memberId, board_id AS boardId, name, is_owner AS isOwner FROM members WHERE token_hash = ?',
      ),
      notes: p(`${NOTE_SELECT} WHERE n.board_id = :board ORDER BY n.pos, n.id`),
      note: p(`${NOTE_SELECT} WHERE n.board_id = :board AND n.id = :id`),
      noteCount: p('SELECT COUNT(*) AS c FROM notes WHERE board_id = ?'),
      insertNote: p(
        `INSERT INTO notes(board_id, col, text, author_id, pos, text_ts, pos_ts, created_at)
         VALUES(:board, :col, :text, :author,
                COALESCE((SELECT MAX(pos) FROM notes WHERE board_id = :board AND col = :col), 0) + 1,
                :ts, :ts, :ts)`,
      ),
      editNote: p('UPDATE notes SET text = ?, text_ts = ? WHERE id = ? AND board_id = ?'),
      moveNote: p('UPDATE notes SET col = ?, pos = ?, pos_ts = ? WHERE id = ? AND board_id = ?'),
      deleteNote: p('DELETE FROM notes WHERE id = ? AND board_id = ?'),
      maxTs: p('SELECT COALESCE(MAX(MAX(text_ts), MAX(pos_ts)), 0) AS ts FROM notes WHERE board_id = ?'),
      votesUsed: p('SELECT COALESCE(SUM(n), 0) AS used FROM votes WHERE board_id = ? AND member_id = ?'),
      voteOf: p('SELECT n FROM votes WHERE note_id = ? AND member_id = ?'),
      voteUpsert: p(
        'INSERT INTO votes(note_id, member_id, board_id, n) VALUES(?,?,?,1) ON CONFLICT(note_id, member_id) DO UPDATE SET n = n + 1',
      ),
      voteDec: p('UPDATE votes SET n = n - 1 WHERE note_id = ? AND member_id = ?'),
      voteDelete: p('DELETE FROM votes WHERE note_id = ? AND member_id = ?'),
      voteTotal: p('SELECT COALESCE(SUM(n), 0) AS total FROM votes WHERE note_id = ?'),
      setAnonymous: p('UPDATE boards SET anonymous = ? WHERE id = ?'),
      setTimer: p('UPDATE boards SET timer_end = ? WHERE id = ?'),
    };
  }

  close() {
    this.db.close();
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // Strictly increasing per board, and server-assigned: this is the "last write"
  // in last-write-wins. Date.now() alone could tie within one millisecond.
  nextTs(boardId) {
    let last = this.lastTs.get(boardId);
    if (last === undefined) last = this.q.maxTs.get(boardId).ts;
    const ts = Math.max(Date.now(), last + 1);
    this.lastTs.set(boardId, ts);
    return ts;
  }

  // --- boards / members -------------------------------------------------

  createBoard({ name, displayName, voteLimit, anonymous }) {
    const boardId = randHex(6);
    const invite = randToken(16);
    const session = randToken(32);
    this.tx(() => {
      const now = Date.now();
      this.q.insertBoard.run(boardId, name, invite, anonymous ? 1 : 0, voteLimit, now);
      this.q.insertMember.run(randHex(8), boardId, displayName, sha256(session), 1, now);
    });
    return { boardId, invite, session };
  }

  inviteInfo(invite) {
    return this.q.boardByInvite.get(invite) ?? null;
  }

  join(invite, displayName) {
    const board = this.q.boardByInvite.get(invite);
    if (!board) return { error: 'bad_invite' };
    const session = randToken(32);
    return this.tx(() => {
      if (this.q.memberCount.get(board.id).c >= MAX_MEMBERS) return { error: 'board_full' };
      this.q.insertMember.run(randHex(8), board.id, displayName, sha256(session), 0, Date.now());
      return { boardId: board.id, session };
    });
  }

  memberBySession(session) {
    const m = this.q.memberBySession.get(sha256(session));
    return m ? { ...m, isOwner: !!m.isOwner } : null;
  }

  board(id) {
    const b = this.q.board.get(id);
    return b ? { ...b, anonymous: !!b.anonymous } : null;
  }

  setAnonymous(boardId, on) {
    this.q.setAnonymous.run(on ? 1 : 0, boardId);
  }

  setTimer(boardId, endsAt) {
    this.q.setTimer.run(endsAt, boardId);
  }

  // --- notes ------------------------------------------------------------

  notes(boardId, viewerId) {
    return this.q.notes.all({ board: boardId, viewer: viewerId ?? '' });
  }

  note(boardId, id, viewerId = '') {
    return this.q.note.get({ board: boardId, id, viewer: viewerId }) ?? null;
  }

  noteCount(boardId) {
    return this.q.noteCount.get(boardId).c;
  }

  addNote(boardId, authorId, col, text) {
    const ts = this.nextTs(boardId);
    const r = this.q.insertNote.run({ board: boardId, col, text, author: authorId, ts });
    return this.note(boardId, Number(r.lastInsertRowid));
  }

  editNote(boardId, id, text) {
    const ts = this.nextTs(boardId);
    this.q.editNote.run(text, ts, id, boardId);
    return ts;
  }

  moveNote(boardId, id, col, pos) {
    const ts = this.nextTs(boardId);
    this.q.moveNote.run(col, pos, ts, id, boardId);
    return ts;
  }

  deleteNote(boardId, id) {
    this.q.deleteNote.run(id, boardId);
  }

  // --- votes ------------------------------------------------------------

  votesRemaining(boardId, memberId, limit) {
    return limit - this.q.votesUsed.get(boardId, memberId).used;
  }

  // Check-and-set inside one transaction so the per-person limit can't be
  // raced past by two connections (or two server processes).
  vote(boardId, noteId, memberId, delta, limit) {
    return this.tx(() => {
      const cur = this.q.voteOf.get(noteId, memberId)?.n ?? 0;
      const used = this.q.votesUsed.get(boardId, memberId).used;
      if (delta > 0) {
        if (used >= limit) return { error: 'vote_limit' };
        this.q.voteUpsert.run(noteId, memberId, boardId);
      } else {
        if (cur <= 0) return { error: 'no_vote' };
        // The CHECK (n > 0) forbids a zero row, so the last vote deletes it.
        if (cur === 1) this.q.voteDelete.run(noteId, memberId);
        else this.q.voteDec.run(noteId, memberId);
      }
      const mine = cur + delta;
      return {
        total: this.q.voteTotal.get(noteId).total,
        mine,
        remaining: limit - (used + delta),
      };
    });
  }
}
