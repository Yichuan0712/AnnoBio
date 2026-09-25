/**
 * Main process: keeps the local Python backend's stdout/stderr for the desktop Log tab — a bounded
 * in-memory tail the renderer reads and subscribes to, plus one file per day under `dir` (the last
 * KEEP_DAYS are kept). The backend prints full prompts and model outputs, so these files stay
 * local. When `tee` is set (running from `npm start`), output is still echoed to the terminal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const MAX_LINES = 2000;
const KEEP_DAYS = 7;
const FLUSH_MS = 100;
// backend/main.py and llm.py color their section headers (_HL / _R); the tab shows those as bold.
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const LOG_FILE_PATTERN = /^backend-(\d{4}-\d{2}-\d{2})\.log$/;

function pruneOldFiles(dir) {
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(dir)) {
    const match = LOG_FILE_PATTERN.exec(name);
    if (match && Date.parse(match[1]) < cutoff) fs.rmSync(path.join(dir, name), { force: true });
  }
}

export function createBackendLog({ dir, tee = false, onLines = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  try { pruneOldFiles(dir); } catch (err) { console.error('[backend-log] prune failed:', err); }

  let lines = [];
  let nextId = 1;
  let pending = [];
  let flushTimer = null;
  let file = { day: '', stream: null };

  function fileStream(now) {
    const day = now.toISOString().slice(0, 10);
    if (file.day !== day) {
      file.stream?.end();
      file = { day, stream: fs.createWriteStream(path.join(dir, `backend-${day}.log`), { flags: 'a' }) };
      file.stream.on('error', (err) => console.error('[backend-log] write failed:', err));
    }
    return file.stream;
  }

  function flush() {
    flushTimer = null;
    const batch = pending;
    pending = [];
    if (batch.length) onLines(batch);
  }

  /** `stream` is 'out' / 'err' for the backend's own output, 'app' for notes from AnnoBio itself. */
  function push(stream, rawText) {
    const now = new Date();
    const text = rawText.replace(ANSI_PATTERN, '').replace(/\r/g, '');
    const entry = { id: nextId++, time: now.getTime(), stream, text, highlight: text !== rawText.replace(/\r/g, '') };
    lines.push(entry);
    if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
    pending.push(entry);
    fileStream(now).write(`${now.toISOString()} ${stream.toUpperCase().padEnd(3)} ${text}\n`);
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  function capture(source, stream, echo) {
    if (!source) return;
    const decoder = new StringDecoder('utf8');
    let partial = '';
    source.on('data', (chunk) => {
      if (tee) {
        try { echo.write(chunk); } catch (_) {}
      }
      const parts = (partial + decoder.write(chunk)).split('\n');
      partial = parts.pop();
      parts.forEach((line) => push(stream, line));
    });
    source.on('end', () => {
      const rest = partial + decoder.end();
      partial = '';
      if (rest) push(stream, rest);
    });
  }

  return {
    dir,
    /** Reads a spawned child's piped stdout/stderr. */
    attach(child) {
      capture(child.stdout, 'out', process.stdout);
      capture(child.stderr, 'err', process.stderr);
    },
    note(text) { push('app', text); },
    lines: () => lines.slice(),
    clear() { lines = []; },
  };
}
