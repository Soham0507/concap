// Long-capture flow: create session → upload audio → add visitor markers → process.
// This page is intentionally a plain script (not a module) — there's no
// IndexedDB queue here; long-capture is online-only.

const $ = (id) => document.getElementById(id);
let session = null;
let pollTimer = null;

// Title is optional — fall back to a timestamped default so the backend
// (which requires a name) and the dashboard list still have something to show.
function defaultSessionTitle() {
  return `Multi conversation — ${new Date().toLocaleString()}`;
}

function showAlert(kind, msg) {
  // Render via textContent so user/server-controlled strings (event names,
  // error details) can't inject markup. Only the "kind" class is interpolated
  // — and it's always one of our own string literals, never user input.
  const el = $("alert");
  if (!msg) { el.innerHTML = ""; return; }
  const div = document.createElement("div");
  div.className = "alert " + (kind || "");
  div.textContent = String(msg);
  el.innerHTML = "";
  el.appendChild(div);
}

function fmtTs(seconds) {
  if (seconds == null || isNaN(seconds)) return "—";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function escapeHTML(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function loadConfig() {
  try {
    const cfg = await fetch("/api/config").then((r) => r.json());
    const sub = $("event-subtitle");
    if (sub) sub.textContent = `${cfg.booth_name} · ${cfg.event_name} — multi-conversation`;
  } catch {}
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- Event/Day category master (mirrors the /transcribe page) -----------
// Pulled fresh on page load (and after creating a new event/day) so the
// dropdowns always reflect what's in the database. The picked day is sent
// with the create-session POST and every derived conversation inherits it.
let EVENTS_CACHE = [];

async function loadEvents(selectEventId, selectDayId) {
  try {
    const r = await fetch("/api/events");
    if (!r.ok) throw new Error(`Failed to load events (${r.status})`);
    EVENTS_CACHE = await r.json();
  } catch (e) {
    EVENTS_CACHE = [];
    return;
  }
  const sel = $("s-event");
  const currentEvent = selectEventId != null ? String(selectEventId) : sel.value;
  sel.innerHTML = `<option value="">— No event —</option>` +
    EVENTS_CACHE.map((e) => `<option value="${e.id}">${esc(e.name)}${e.location ? ` · ${esc(e.location)}` : ""}</option>`).join("");
  if (currentEvent && EVENTS_CACHE.some((e) => String(e.id) === currentEvent)) {
    sel.value = currentEvent;
  }
  renderDays(selectDayId);
}

function renderDays(selectDayId) {
  const eventId = $("s-event").value;
  const daySel = $("s-day");
  const addLink = $("s-add-day");
  if (!eventId) {
    daySel.innerHTML = `<option value="">— Pick an event first —</option>`;
    daySel.disabled = true;
    addLink.classList.add("hidden");
    return;
  }
  const ev = EVENTS_CACHE.find((e) => String(e.id) === String(eventId));
  const days = (ev && ev.days) || [];
  daySel.disabled = false;
  daySel.innerHTML = `<option value="">— No day —</option>` +
    days.map((d) => `<option value="${d.id}">${esc(d.label || `Day ${d.day_number}`)}</option>`).join("");
  if (selectDayId != null && days.some((d) => d.id === selectDayId)) {
    daySel.value = String(selectDayId);
  }
  addLink.classList.remove("hidden");
}

async function createEventFlow() {
  const name = prompt("Event name (e.g. CES Las Vegas 2026):");
  if (!name || !name.trim()) return;
  const location = prompt("Location (optional, e.g. Las Vegas, NV):") || "";
  const startDateRaw = prompt("Start date (YYYY-MM-DD, optional — Day 1's date):", "") || "";
  const startDate = startDateRaw.trim();
  if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    showAlert("error", "Start date must look like 2026-01-08 — leaving it blank is fine.");
    return;
  }
  const dayCountRaw = prompt("How many days? (default 1)", "1");
  const dayCount = Math.max(1, Math.min(30, parseInt(dayCountRaw, 10) || 1));
  try {
    const r = await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        location: location.trim() || null,
        day_count: dayCount,
        start_date: startDate ? `${startDate}T00:00:00` : null,
      }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.detail || `Failed (${r.status})`);
    }
    const ev = await r.json();
    await loadEvents(ev.id, (ev.days && ev.days[0] && ev.days[0].id) || null);
    showAlert("success", `Created "${esc(ev.name)}" with ${ev.days.length} day${ev.days.length === 1 ? "" : "s"}.`);
  } catch (e) {
    showAlert("error", "Could not create event: " + e.message);
  }
}

async function addDayFlow() {
  const eventId = $("s-event").value;
  if (!eventId) return;
  const label = prompt("Day label (leave blank for auto Day N):") || "";
  const dateRaw = prompt("Day date (YYYY-MM-DD, optional):", "") || "";
  const dayDate = dateRaw.trim();
  if (dayDate && !/^\d{4}-\d{2}-\d{2}$/.test(dayDate)) {
    showAlert("error", "Day date must look like 2026-01-08 — leaving it blank is fine.");
    return;
  }
  try {
    const r = await fetch(`/api/events/${eventId}/days`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: label.trim() || null,
        event_date: dayDate ? `${dayDate}T00:00:00` : null,
      }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.detail || `Failed (${r.status})`);
    }
    const day = await r.json();
    await loadEvents(Number(eventId), day.id);
    showAlert("success", `Added ${esc(day.label || `Day ${day.day_number}`)}.`);
  } catch (e) {
    showAlert("error", "Could not add day: " + e.message);
  }
}

// -- Loader + upload helpers (mirrors the Quick transcribe experience) ------

function startLoader() {
  $("lc-loader").classList.remove("hidden");
  const bar = $("lc-progress-bar");
  const status = $("lc-loader-status");
  bar.style.width = "0%";
  status.textContent = "Starting…";
  return { bar, status };
}
function stopLoader() {
  $("lc-loader").classList.add("hidden");
}

// XHR upload so we get real byte-level progress. auth.js patches fetch to add
// the bearer token, but XHR bypasses that wrapper — attach the token ourselves
// so big uploads don't 401.
function uploadWithProgress(url, fd, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    try {
      const token = localStorage.getItem("booth_auth_token");
      if (token) xhr.setRequestHeader("Authorization", "Bearer " + token);
    } catch { /* private mode / disabled storage — let server 401 */ }
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    });
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* non-JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.detail || `Failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(fd);
  });
}

// Reveal the review/marking area and wire inline playback from the file
// already in memory (no re-download from the server).
function revealWork(file) {
  $("card-markers").classList.remove("hidden");
  const player = $("audio-player");
  player.src = URL.createObjectURL(file);
  player.addEventListener("loadedmetadata", () => {
    const d = isFinite(player.duration) ? player.duration : session.duration_seconds;
    $("cur-duration").value = fmtTs(d);
  }, { once: true });
  player.addEventListener("timeupdate", () => {
    $("cur-position").value = fmtTs(player.currentTime);
  });
  // Many voice recorders (Sony/Olympus etc.) write WAV variants the browser
  // can't decode for inline playback. That only affects MANUAL marking — AI
  // auto-detection runs server-side and works regardless. Surface this clearly
  // instead of looking broken.
  player.addEventListener("error", () => {
    player.classList.add("hidden");
    showAlert(
      "warning",
      "Your browser can't play this recorder's audio format inline, so manual " +
        "scrubbing is unavailable for this file. AI auto-detection (running now) " +
        "processes the recording server-side and doesn't need browser playback. " +
        "For manual marking instead, convert the file to a 16-bit PCM WAV or MP3."
    );
  }, { once: true });
  $("cur-duration").value = fmtTs(session.duration_seconds);
  renderMarkers();
}

// -- Start: create session, upload audio, and auto-detect — all in one go ---

$("btn-start").addEventListener("click", async () => {
  const name = $("s-name").value.trim() || defaultSessionTitle();
  const f = $("s-audio").files[0];
  if (!f) { showAlert("error", "Pick an audio file first."); return; }

  $("btn-start").disabled = true;
  showAlert(null);
  const sizeMB = f.size / 1024 / 1024;
  const { bar, status } = startLoader();
  let creep = null;
  try {
    // 1. Create the session record.
    status.textContent = "Creating session…";
    const cr = await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        recording_started_at: new Date().toISOString(),
        event_day_id: $("s-day").value ? Number($("s-day").value) : null,
      }),
    });
    if (!cr.ok) throw new Error(`Create failed (${cr.status})`);
    session = await cr.json();

    // 2. Probe duration in-browser (segmentation needs it when the server has
    //    no ffprobe) and upload with a real progress bar.
    const clientDuration = await probeDurationFromFile(f);
    status.textContent = `Uploading ${sizeMB.toFixed(1)} MB…`;
    const fd = new FormData();
    fd.append("file", f, f.name);
    if (clientDuration && isFinite(clientDuration) && clientDuration > 0) {
      fd.append("client_duration_seconds", String(clientDuration));
    }
    session = await uploadWithProgress(`/api/sessions/${session.id}/audio`, fd, (frac) => {
      const pct = Math.min(60, Math.round(frac * 60));
      bar.style.width = pct + "%";
      // The 100% progress event can fire more than once — only ever spin up
      // the "processing creep" interval the first time, so we don't leak timers.
      if (frac >= 1 && !creep) {
        status.textContent = "Processing the recording…";
        let p = 60;
        creep = setInterval(() => { p = Math.min(92, p + 0.6); bar.style.width = p + "%"; }, 350);
      }
    });
    if (creep) { clearInterval(creep); creep = null; }
    bar.style.width = "100%";
    status.textContent = "Done.";

    // 3. Reveal the review area and auto-kick AI detection so the user never
    //    has to mark visitors by hand.
    revealWork(f);
    setTimeout(stopLoader, 400);
    showAlert("success", "Recording uploaded. AI is finding the visitors automatically…");
    autoConfirmPending = true;
    $("btn-auto-detect").click();
  } catch (e) {
    if (creep) clearInterval(creep);
    stopLoader();
    showAlert("error", "Couldn't start: " + e.message);
    // Auto-start fires from file selection, so clear the picked file on failure;
    // otherwise re-selecting the same recording won't re-fire the change event.
    const audio = $("s-audio");
    if (audio) audio.value = "";
    const nameEl = $("s-file-name");
    if (nameEl) { nameEl.textContent = "No file selected yet"; nameEl.classList.remove("has-file"); }
  } finally {
    $("btn-start").disabled = false;
  }
});

// Load just enough of the file into an <audio> element to read its duration.
function probeDurationFromFile(file) {
  return new Promise((resolve) => {
    try {
      const el = document.createElement("audio");
      el.preload = "metadata";
      const url = URL.createObjectURL(file);
      const done = (val) => {
        URL.revokeObjectURL(url);
        resolve(val);
      };
      el.addEventListener("loadedmetadata", () => {
        const d = el.duration;
        done(isFinite(d) && d > 0 ? d : null);
      });
      el.addEventListener("error", () => done(null));
      // Safety timeout — never block the upload on a stubborn decoder.
      setTimeout(() => done(isFinite(el.duration) && el.duration > 0 ? el.duration : null), 4000);
      el.src = url;
    } catch {
      resolve(null);
    }
  });
}

// -- Drag & drop wiring for the audio dropzone -----------------------------
// Mirrors the Quick transcribe dropzone: click/keyboard to browse, drag-drop,
// and a selected-file label. The dropped file is stuffed into the hidden
// <input> so the Start handler reads it the same way a browse pick works.
(function () {
  const dz = $("lc-dropzone");
  const input = $("s-audio");
  const nameEl = $("s-file-name");
  if (!dz || !input) return;

  function setFile(file) {
    if (!file) return;
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
    } catch { /* programmatic file assignment can fail in some browsers */ }
    const mb = (file.size / 1024 / 1024).toFixed(1);
    nameEl.textContent = `${file.name} · ${mb} MB`;
    nameEl.classList.add("has-file");
    // The whole pipeline (create session → upload → AI detect → split + analyze)
    // is automatic: as soon as a file is chosen, kick it off without waiting for
    // a manual "Start session" click.
    const startBtn = $("btn-start");
    if (startBtn && !startBtn.disabled) startBtn.click();
  }

  dz.addEventListener("click", (e) => {
    if (e.target === input) return;
    input.click();
  });
  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
  });
  input.addEventListener("change", () => {
    const f = input.files && input.files[0];
    if (f) setFile(f);
  });

  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      dz.classList.add("is-dragging");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      dz.classList.remove("is-dragging");
    })
  );
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (!/^audio\//.test(f.type) && !/\.(wav|mp3|m4a|mp4|webm|ogg|flac)$/i.test(f.name)) {
      showAlert("error", "That doesn't look like an audio file.");
      return;
    }
    setFile(f);
  });
  // Prevent the browser from navigating away if the user drops outside the zone.
  ["dragover", "drop"].forEach((ev) =>
    window.addEventListener(ev, (e) => { e.preventDefault(); })
  );
})();

// -- Manual marking --------------------------------------------------------

function visitorPayloadFromForm() {
  const trimOrNull = (id) => $(id).value.trim() || null;
  return {
    name: trimOrNull("v-name"),
    company: trimOrNull("v-company"),
    email: trimOrNull("v-email"),
    phone: trimOrNull("v-phone"),
    industry: trimOrNull("v-industry"),
    interest_category: trimOrNull("v-interest"),
  };
}

async function addMarker(type) {
  const player = $("audio-player");
  const t = player.currentTime;
  if (!isFinite(t) || t < 0) {
    showAlert("error", "Position the audio first.");
    return;
  }
  const visitorData = visitorPayloadFromForm();
  const label = visitorData.name
    ? (visitorData.company ? `${visitorData.name} (${visitorData.company})` : visitorData.name)
    : null;

  try {
    const r = await fetch(`/api/sessions/${session.id}/markers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        marker_type: type,
        timestamp_seconds: t,
        label,
        visitor_data: visitorData,
      }),
    });
    if (!r.ok) throw new Error(`Marker save failed (${r.status})`);
    await refreshSession();
  } catch (e) {
    showAlert("error", e.message);
  }
}

$("btn-set-start").addEventListener("click", () => addMarker("visitor_start"));
$("btn-set-end").addEventListener("click", () => addMarker("visitor_end"));
$("btn-clear-form").addEventListener("click", () => {
  ["v-name", "v-company", "v-email", "v-phone", "v-industry", "v-interest"].forEach(
    (id) => ($(id).value = "")
  );
});

async function refreshSession() {
  if (!session) return;
  try {
    const r = await fetch(`/api/sessions/${session.id}`);
    if (!r.ok) return;
    session = await r.json();
    renderMarkers();
    renderStatusBlocks();
  } catch {}
}

function renderMarkers() {
  $("marker-count").value = String(session.markers.length);
  const body = $("marker-body");
  if (!session.markers.length) {
    body.innerHTML = '<tr><td colspan="5" class="muted">No markers yet.</td></tr>';
    return;
  }
  body.innerHTML = session.markers
    .map((m) => {
      const vd = m.visitor_data || {};
      return `
        <tr>
          <td><span class="pill ${m.marker_type === "visitor_start" ? "analyzed" : m.marker_type === "visitor_end" ? "transcribing" : "created"}">${m.marker_type.replace("_", " ")}</span></td>
          <td>${fmtTs(m.timestamp_seconds)}</td>
          <td>${escapeHTML(vd.name || m.label || "")}</td>
          <td>${escapeHTML(vd.company || "")}</td>
          <td><button class="secondary" data-del="${m.id}" style="padding: 4px 10px; font-size: 12px;">Delete</button></td>
        </tr>`;
    })
    .join("");

  body.querySelectorAll("button[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await fetch(`/api/sessions/${session.id}/markers/${btn.dataset.del}`, { method: "DELETE" });
        await refreshSession();
      } catch (e) {
        showAlert("error", e.message);
        btn.disabled = false;
      }
    });
  });
}

// -- AI auto-detect ---------------------------------------------------------

let autoPoll = null;
// Auto-confirm only the first detection run kicked off right after upload —
// never a manual "Re-run AI detection", which would append duplicate records.
let autoConfirmPending = false;
// Guards /confirm against overlapping in-flight POSTs (async polling ticks
// could otherwise both observe "proposed" and submit twice).
let confirmInFlight = false;

$("btn-auto-detect").addEventListener("click", async () => {
  $("btn-auto-detect").disabled = true;
  $("auto-status").textContent = "Starting transcription + AI analysis…";
  try {
    const r = await fetch(`/api/sessions/${session.id}/auto-detect`, { method: "POST" });
    if (!r.ok) {
      let detail = `${r.status}`;
      try { detail = (await r.json()).detail || detail; } catch {}
      throw new Error(detail);
    }
    session = await r.json();
    if (autoPoll) clearInterval(autoPoll);
    autoPoll = setInterval(async () => {
      await refreshSession();
      const st = session && session.status;
      if (st === "detecting" || st === "queued") {
        $("auto-status").textContent =
          "Transcribing the full recording with speaker separation… (a few minutes for long audio)";
      } else if (st === "proposed") {
        clearInterval(autoPoll); autoPoll = null;
        renderProposal();
        if (autoConfirmPending) {
          // Fully automatic (post-upload run): split + analyze with no click.
          autoConfirmPending = false;
          $("auto-status").textContent = "Visitors detected — creating conversations automatically…";
          await confirmProposal({ auto: true });
        } else {
          // Manual re-run: let the user review and confirm so we never append
          // duplicate records automatically.
          $("auto-status").textContent = "Done — review the proposal below.";
        }
        $("btn-auto-detect").disabled = false;
      } else if (st === "error") {
        clearInterval(autoPoll); autoPoll = null;
        $("auto-status").textContent = "";
        $("btn-auto-detect").disabled = false;
        showAlert("error", session.error_message || "Auto-detect failed.");
      }
    }, 4000);
  } catch (e) {
    $("auto-status").textContent = "";
    $("btn-auto-detect").disabled = false;
    showAlert("error", e.message);
  }
});

function renderProposal() {
  const prop = session.ai_proposal;
  if (!prop || !Array.isArray(prop.sessions)) return;
  $("proposal-wrap").classList.remove("hidden");
  const body = $("proposal-body");
  body.innerHTML = prop.sessions
    .map((sx, i) => {
      const isCustomer = sx.classification === "customer";
      return `<tr data-i="${i}">
        <td><input type="checkbox" data-use ${isCustomer ? "checked" : ""} style="width:auto;"/></td>
        <td><input type="text" data-company value="${escapeHTML(sx.company || "")}" /></td>
        <td><input type="text" data-name value="${escapeHTML((sx.visitor_names || []).join(", "))}" placeholder="optional" /></td>
        <td><input type="text" data-start value="${fmtTs(sx.start_seconds)}" style="width:80px;" /></td>
        <td><input type="text" data-end value="${fmtTs(sx.end_seconds)}" style="width:80px;" /></td>
        <td class="muted">${escapeHTML((sx.topics || []).join(", "))}</td>
        <td><span class="pill ${isCustomer ? "analyzed" : "created"}">${escapeHTML(sx.classification)}</span></td>
      </tr>`;
    })
    .join("");
}

function parseTs(v) {
  v = String(v).trim();
  if (v.includes(":")) {
    const [m, s] = v.split(":").map(Number);
    return (m || 0) * 60 + (s || 0);
  }
  return Number(v) || 0;
}

async function confirmProposal({ auto = false } = {}) {
  if (confirmInFlight) return;
  const rows = [...document.querySelectorAll("#proposal-body tr")];
  const sessions = rows
    .filter((tr) => tr.querySelector("[data-use]").checked)
    .map((tr) => ({
      company: tr.querySelector("[data-company]").value.trim() || null,
      visitor_name: tr.querySelector("[data-name]").value.trim() || null,
      start_seconds: parseTs(tr.querySelector("[data-start]").value),
      end_seconds: parseTs(tr.querySelector("[data-end]").value),
    }))
    .filter((s) => s.end_seconds > s.start_seconds);

  if (!sessions.length) {
    // In the automatic flow we don't error out — the AI just didn't find a
    // clear visitor conversation. Leave the proposal up for manual review.
    if (auto) {
      $("auto-status").textContent =
        "No clear visitor conversations were detected — review the proposal below.";
      return;
    }
    showAlert("error", "Tick at least one session with a valid time range.");
    return;
  }
  confirmInFlight = true;
  $("btn-confirm").disabled = true;
  $("confirm-status").textContent = "Creating records…";
  if (auto) showAlert("info", "Splitting the recording into conversations and analyzing each one…");
  try {
    const r = await fetch(`/api/sessions/${session.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions }),
    });
    if (!r.ok) {
      let detail = `${r.status}`;
      try { detail = (await r.json()).detail || detail; } catch {}
      throw new Error(detail);
    }
    session = await r.json();
    $("card-markers").classList.add("hidden");
    $("card-processed").classList.remove("hidden");
    renderStatusBlocks();
    if (auto) showAlert("success", "Done — conversations created and analyzed automatically.");
  } catch (e) {
    $("confirm-status").textContent = "";
    $("btn-confirm").disabled = false;
    showAlert("error", e.message);
  } finally {
    confirmInFlight = false;
  }
}

$("btn-confirm").addEventListener("click", () => confirmProposal());

// -- Process (manual marker path) ------------------------------------------

$("btn-process").addEventListener("click", async () => {
  if (!session.markers.some((m) => m.marker_type === "visitor_start")) {
    showAlert("error", "Add at least one visitor_start marker before processing.");
    return;
  }
  $("btn-process").disabled = true;
  showAlert("info", "Slicing audio + running transcription & analysis. This may take a few minutes for long recordings.");
  try {
    const r = await fetch(`/api/sessions/${session.id}/process`, { method: "POST" });
    if (!r.ok) {
      let detail = `${r.status}`;
      try { detail = (await r.json()).detail || detail; } catch {}
      throw new Error(detail);
    }
    session = await r.json();
    $("card-markers").classList.add("hidden");
    $("card-processed").classList.remove("hidden");
    renderStatusBlocks();
    startPolling();
  } catch (e) {
    showAlert("error", e.message);
    $("btn-process").disabled = false;
  }
});

$("btn-refresh").addEventListener("click", refreshSession);
$("btn-refresh-2").addEventListener("click", refreshSession);

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    await refreshSession();
    if (session && (session.status === "processed" || session.status === "error")) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }, 4000);
}

function renderStatusBlocks() {
  const body = $("processed-body");
  if (!session) return;
  const errBlock = session.error_message
    ? `<div class="alert error">${escapeHTML(session.error_message)}</div>`
    : "";
  const convCount = session.derived_conversation_ids.length;
  const convLinks = session.derived_conversation_ids
    .map((id) => `<a href="/dashboard#conv-${id}" target="_blank" style="margin-right: 10px;">#${id}</a>`)
    .join("");
  body.innerHTML = `
    ${errBlock}
    <div style="display: flex; gap: 16px; align-items: center; margin-bottom: 14px;">
      <span class="pill ${session.status}">${session.status}</span>
      <span class="muted">Session #${session.id} — ${escapeHTML(session.name)}</span>
      <span class="muted">${session.markers.length} markers · ${convCount} conversation(s) derived</span>
    </div>
    ${convCount ? `<div><strong>Conversations:</strong> ${convLinks}</div>` : "<div class='muted'>Conversations will appear here as each segment finishes transcription + analysis.</div>"}
  `;
}

loadConfig();
loadEvents();
$("s-event").addEventListener("change", () => renderDays());
$("s-new-event").addEventListener("click", (e) => { e.preventDefault(); createEventFlow(); });
$("s-add-day").addEventListener("click", (e) => { e.preventDefault(); addDayFlow(); });
