const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'bot-state.json');

let cache = null;
let writeTimer = null;

function read() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}

function flush() {
  writeTimer = null;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(cache ?? {}, null, 2), 'utf8');
  } catch (err) {
    console.error('[store] could not persist state:', err.message);
  }
}

function get(key, fallback) {
  const value = read()[key];
  return value === undefined ? fallback : value;
}

/** Writes are debounced — voice events can fire many times per second. */
function set(key, value) {
  read()[key] = value;
  if (writeTimer) return;
  writeTimer = setTimeout(flush, 1000);
}

function flushNow() {
  if (writeTimer) clearTimeout(writeTimer);
  flush();
}

module.exports = { get, set, flushNow, STATE_FILE };
