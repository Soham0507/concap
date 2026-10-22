/**
 * IndexedDB-backed offline capture queue.
 *
 * Each entry stores everything needed to replay a booth capture against
 * /api/captures: a client-generated UUID, the visitor + consent metadata,
 * the audio Blob, and bookkeeping fields (state, attempts, lastError).
 *
 * Lifecycle:
 *   pending  -> never sent successfully
 *   sending  -> a flush is in-flight
 *   done     -> server accepted (we delete shortly after)
 *
 * The drain loop runs whenever:
 *   - The page loads (boot)
 *   - The browser fires 'online'
 *   - A 20-second timer ticks (belt-and-braces for flaky Wi-Fi)
 *   - The Service Worker fires a sync/message event (when supported)
 */

const DB_NAME = "booth-capture";
const DB_VERSION = 1;
const STORE = "captures";

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("state", "state", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(mode) {
  return openDB().then((db) => db.transaction(STORE, mode).objectStore(STORE));
}

function uuid() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  // Fallback for older browsers — RFC4122 v4-ish, not cryptographic.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export const Queue = {
  /**
   * Enqueue a capture for upload. Returns the entry's id so the UI can
   * track its state.
   */
  async enqueue({ visitor, companyId, consent, staffName, audioBlob, audioMime }) {
    const id = uuid();
    const entry = {
      id,
      state: "pending",
      attempts: 0,
      lastError: null,
      createdAt: Date.now(),
      visitor,
      // Authoritative company link picked from the booth's typeahead — sent
      // through to /api/captures so the new Conversation is linked directly
      // (not just transitively via the visitor's free-text company string).
      companyId: companyId ?? null,
      consent,
      staffName,
      audioBlob,
      audioMime: audioMime || (audioBlob && audioBlob.type) || "audio/webm",
    };
    const store = await tx("readwrite");
    await req2promise(store.add(entry));
    return id;
  },

  async list(filter) {
    const store = await tx("readonly");
    const all = await req2promise(store.getAll());
    return filter ? all.filter(filter) : all;
  },

  async count(state) {
    const all = await this.list();
    return state ? all.filter((e) => e.state === state).length : all.length;
  },

  async get(id) {
    const store = await tx("readonly");
    return req2promise(store.get(id));
  },

  async update(id, patch) {
    const store = await tx("readwrite");
    const cur = await req2promise(store.get(id));
    if (!cur) return null;
    const next = { ...cur, ...patch };
    await req2promise(store.put(next));
    return next;
  },

  async delete(id) {
    const store = await tx("readwrite");
    await req2promise(store.delete(id));
  },
};

function req2promise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Try once to flush a single entry to the server. Returns true on success.
 * The server endpoint is idempotent on client_capture_id, so retries after
 * a partial failure are safe.
 */
async function flushOne(entry) {
  const fd = new FormData();
  const ext = (entry.audioMime || "audio/webm").includes("ogg") ? "ogg"
            : (entry.audioMime || "audio/webm").includes("mp4") ? "mp4"
            : "webm";

  const metadata = {
    client_capture_id: entry.id,
    visitor: entry.visitor,
    company_id: entry.companyId ?? null,
    consent: entry.consent,
    staff_name: entry.staffName || null,
  };
  fd.append("metadata", JSON.stringify(metadata));
  fd.append("audio", entry.audioBlob, `capture.${ext}`);

  const resp = await fetch("/api/captures", { method: "POST", body: fd });

  if (resp.ok) return true;

  // 401/403 = the rep's token expired or they're logged out. This is
  // recoverable: once they sign back in, the periodic drain will succeed.
  // Treat it like a transient network error so the capture STAYS queued
  // rather than being thrown away.
  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`Auth required (${resp.status}) — capture kept in queue`);
  }

  // 4xx (other than 401/403/408/429) means the server permanently rejected
  // it — a bad payload won't get better by retrying. Mark failed and stop.
  if (resp.status >= 400 && resp.status < 500 && resp.status !== 408 && resp.status !== 429) {
    let detail = `${resp.status}`;
    try { detail = (await resp.json()).detail || detail; } catch {}
    throw new PermanentError(detail);
  }
  // 5xx / network-ish — caller should retry later.
  throw new Error(`Server returned ${resp.status}`);
}

class PermanentError extends Error {
  constructor(msg) { super(msg); this.permanent = true; }
}

let _draining = false;

export async function drainQueue({ onChange } = {}) {
  if (_draining) return { drained: 0, remaining: await Queue.count("pending") };
  if (!navigator.onLine) {
    return { drained: 0, remaining: await Queue.count("pending"), skipped: "offline" };
  }

  _draining = true;
  let drained = 0;
  try {
    const pending = await Queue.list((e) => e.state === "pending" || e.state === "sending");
    pending.sort((a, b) => a.createdAt - b.createdAt);

    for (const entry of pending) {
      try {
        await Queue.update(entry.id, { state: "sending", attempts: (entry.attempts || 0) + 1 });
        onChange && onChange();
        await flushOne(entry);
        await Queue.delete(entry.id);
        drained++;
        onChange && onChange();
      } catch (err) {
        if (err instanceof PermanentError) {
          await Queue.update(entry.id, { state: "failed", lastError: err.message });
        } else {
          await Queue.update(entry.id, { state: "pending", lastError: String(err.message || err) });
          // Network is flaky — don't hammer it; stop after the first failure
          // and let the next online/timer tick try again.
          break;
        }
        onChange && onChange();
      }
    }
    return { drained, remaining: await Queue.count("pending") };
  } finally {
    _draining = false;
  }
}

/**
 * Wire up the global drain triggers. Call once during app boot.
 */
export function installDrainTriggers({ onChange } = {}) {
  const trigger = () => drainQueue({ onChange }).catch(() => {});

  window.addEventListener("online", trigger);
  // Belt-and-braces: a periodic tick handles the case where 'online' lies
  // (it often does on captive-portal venue Wi-Fi).
  setInterval(trigger, 20_000);

  // Ask the Service Worker to register a Background Sync. When the OS
  // wakes the SW up after connectivity returns, the SW posts a message
  // back here to drain. On browsers without sync, this is a no-op.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data && e.data.type === "drain") trigger();
    });
    navigator.serviceWorker.ready
      .then((reg) => reg.sync && reg.sync.register("booth-capture-drain"))
      .catch(() => {});
  }

  // Initial flush attempt on boot.
  trigger();
}
