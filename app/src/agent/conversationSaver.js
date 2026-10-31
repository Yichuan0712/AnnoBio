/** Debounce edits and keep at most one write in flight. Snapshot only when writing,
 * so a slow network never accumulates full conversation copies or stale requests. */
export function createConversationSaver(write, delay = 300) {
  let dirty = false;
  let timer = null;
  let running = null;

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (running) return running;
    if (!dirty) return Promise.resolve();
    running = (async () => {
      while (dirty) {
        dirty = false;
        await write();
      }
    })().finally(() => { running = null; });
    return running;
  }

  return {
    schedule() {
      dirty = true;
      clearTimeout(timer);
      timer = setTimeout(() => { void flush(); }, delay);
    },
    flush,
  };
}
