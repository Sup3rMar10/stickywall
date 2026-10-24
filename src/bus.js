// Board event bus. The WebSocket layer only talks to this interface:
//   subscribe(boardId, fn) -> unsubscribe()
//   publish(boardId, event)
// LocalBus delivers in-process. A Redis version would PUBLISH to `board:<id>`
// and SUBSCRIBE on the first local client of a board; nothing else changes
// because events are raw (recipient-independent) and each node renders them
// per client. See docs/ARCHITECTURE.md.

export class LocalBus {
  constructor() {
    this.subs = new Map();
  }

  subscribe(boardId, fn) {
    let set = this.subs.get(boardId);
    if (!set) this.subs.set(boardId, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.subs.delete(boardId);
    };
  }

  publish(boardId, event) {
    for (const fn of this.subs.get(boardId) ?? []) fn(event);
  }
}
