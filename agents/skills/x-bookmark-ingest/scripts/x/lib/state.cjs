const fs = require('fs');
const path = require('path');

const WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE
  || path.join(process.env.HOME || '/root', '.openclaw', 'workspace');
const STATE_DIR = process.env.OPENCLAW_STATE_DIR
  || path.join(WORKSPACE_DIR, 'brain', 'state');

const PENDING_FILE = path.join(STATE_DIR, 'x-bookmark-pending.json');
const PROCESSED_FILE = path.join(STATE_DIR, 'x-bookmark-processed.json');

function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

function readJSON(filepath, defaultValue = []) {
  ensureStateDir();
  if (!fs.existsSync(filepath)) {
    return defaultValue;
  }
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (e) {
    console.error(`Error reading ${filepath}:`, e.message);
    return defaultValue;
  }
}

function writeJSON(filepath, data) {
  ensureStateDir();
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

function getPending() {
  return readJSON(PENDING_FILE, []);
}

function setPending(bookmarks) {
  writeJSON(PENDING_FILE, bookmarks);
}

function getProcessed() {
  return readJSON(PROCESSED_FILE, []);
}

function addProcessed(ids) {
  const processed = getProcessed();
  const newIds = Array.isArray(ids) ? ids : [ids];
  const updated = [...new Set([...processed, ...newIds])];
  writeJSON(PROCESSED_FILE, updated);
}

function filterPending(processedIds) {
  const pending = getPending();
  const processed = new Set(processedIds);
  const filtered = pending.filter(b => !processed.has(b.id));
  setPending(filtered);
  return filtered;
}

module.exports = {
  STATE_DIR,
  PENDING_FILE,
  PROCESSED_FILE,
  getPending,
  setPending,
  getProcessed,
  addProcessed,
  filterPending
};
