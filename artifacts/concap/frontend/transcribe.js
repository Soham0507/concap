// Quick transcribe: upload audio -> transcript + saved record.
const $ = (id) => document.getElementById(id);

// --- Event/Day category master ------------------------------------------
// Pulled fresh on page load (and after creating a new event/day) so the
// dropdowns always reflect what's in the database.
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
  const sel = $("t-event");
  const currentEvent = selectEventId != null ? String(selectEventId) : sel.value;
  sel.innerHTML = `<option value="">— No event —</option>` +
    EVENTS_CACHE.map((e) => `<option value="${e.id}">${esc(e.name)}${e.location ? ` · ${esc(e.location)}` : ""}</option>`).join("");
  // Restore previous pick if still present, otherwise apply the requested one.
  if (currentEvent && EVENTS_CACHE.some((e) => String(e.id) === currentEvent)) {
    sel.value = currentEvent;
  }
  renderDays(selectDayId);
}

function renderDays(selectDayId) {
  const eventId = $("t-event").value;
  const daySel = $("t-day");
  const addLink = $("t-add-day");
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
  // Light client-side validation so we don't ship junk to the backend (it
  // would 422 anyway, but a clean message here is friendlier).
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
    showAlert("success", `Created "${ev.name}" with ${ev.days.length} day${ev.days.length === 1 ? "" : "s"}.`);
  } catch (e) {
    showAlert("error", "Could not create event: " + e.message);
  }
}

async function addDayFlow() {
  const eventId = $("t-event").value;
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
    showAlert("success", `Added ${day.label || `Day ${day.day_number}`}.`);
  } catch (e) {
    showAlert("error", "Could not add day: " + e.message);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadEvents();
  $("t-event").addEventListener("change", () => renderDays());
  $("t-new-event").addEventListener("click", (e) => { e.preventDefault(); createEventFlow(); });
  $("t-add-day").addEventListener("click", (e) => { e.preventDefault(); addDayFlow(); });
});

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function showAlert(kind, msg) {
  // Render the message via textContent so user/server-controlled strings
  // (event names, error details from prompt() flows, etc.) can't inject
  // markup. Only the "kind" class is interpolated — and it's our own
  // string literal, never user input.
  const el = $("alert");
  if (!msg) { el.innerHTML = ""; return; }
  const div = document.createElement("div");
  div.className = "alert " + (kind || "");
  div.textContent = String(msg);
  el.innerHTML = "";
  el.appendChild(div);
}

// Colors cycled per speaker for the chip + stacked bar. Order matches the
// reference design (green, purple, orange, blue, …).
const SPEAKER_COLORS = ["#10b981", "#8b5cf6", "#f59e0b", "#3b82f6", "#ec4899", "#14b8a6"];

function speakerLabel(raw, index) {
  // "Speaker 0" -> "Speaker A", "Speaker 1" -> "Speaker B", ... so the UI
  // matches the reference. Falls back to the raw label if it isn't numeric.
  const m = /Speaker\s+(\d+)/i.exec(String(raw || ""));
  if (!m) return raw || `Speaker ${String.fromCharCode(65 + index)}`;
  const n = parseInt(m[1], 10);
  return `Speaker ${String.fromCharCode(65 + (isNaN(n) ? index : n))}`;
}

// GPT auto-detects names when a speaker introduces themselves or gets
// addressed by name. Server returns { "Speaker 0": "Ahmed", ... } only for
// confident hits — anything else is just left out.
function autoSpeakerName(speakerNames, raw) {
  if (!speakerNames || typeof speakerNames !== "object") return "";
  const v = speakerNames[raw];
  return (typeof v === "string" ? v.trim() : "");
}

function fmtDateDMY(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  // Render in the user's local timezone so the date matches the wall-clock
  // moment they actually uploaded the file (server stores UTC, marked with Z).
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()} ${hh}:${mi}`;
}

function renderSpeakerSummary(data) {
  const summaryEl = $("speaker-summary");
  if (!summaryEl) return;

  // No diarization (Whisper provider) -> hide the whole panel cleanly.
  if (!data.diarized || !data.speaker_count) {
    summaryEl.classList.add("hidden");
    summaryEl.innerHTML = "";
    return;
  }

  // Collapse a long tail of tiny contributors into "other" so the bar/chip
  // row stays readable for noisy crowd recordings.
  const names = data.speaker_names || {};
  const stats = (data.speaker_stats || []).map((s, i) => {
    const auto = autoSpeakerName(names, s.speaker);
    return {
      ...s,
      label: auto || speakerLabel(s.speaker, i),
      isAuto: Boolean(auto),
      color: SPEAKER_COLORS[i % SPEAKER_COLORS.length],
    };
  });
  const KEEP = 3;
  let display = stats;
  if (stats.length > KEEP + 1) {
    const head = stats.slice(0, KEEP);
    const tail = stats.slice(KEEP);
    const tailPct = tail.reduce((acc, s) => acc + s.percent, 0);
    display = [
      ...head,
      { label: `${tail.length} other`, percent: Math.round(tailPct * 10) / 10, color: "#3b82f6", isOther: true },
    ];
  }

  const chips = stats
    .map(
      (s) =>
        `<span class="speaker-chip"><span class="dot" style="background:${s.color}"></span>${esc(s.label)}</span>`
    )
    .join("");

  const segments = display
    .map((s) => `<span class="seg" style="width:${s.percent}%;background:${s.color}" title="${esc(s.label)} ${s.percent}%"></span>`)
    .join("");

  const legend = display
    .map(
      (s) =>
        `<span class="legend-item"><span class="dot" style="background:${s.color}"></span><strong>${esc(s.label)}</strong> <span class="muted">${s.percent}%</span></span>`
    )
    .join("");

  const dateStr = fmtDateDMY(data.created_at);
  summaryEl.classList.remove("hidden");
  summaryEl.innerHTML = `
    <div class="speaker-chip-row">
      <span class="speaker-chip count"><span class="ic">◔</span>${data.speaker_count} speakers detected</span>
      ${chips}
    </div>
    <div class="speaker-bar">${segments}</div>
    <div class="speaker-legend">${legend}</div>
    <div class="speaker-footer muted">
      <span><span class="ic">◔</span> ${data.speaker_count} participants</span>
      ${dateStr ? `<span><span class="ic">▦</span> ${esc(dateStr)}</span>` : ""}
    </div>
  `;
}

// Drives the progress bar in the loading card. Upload progress is real
// (XHR gives us byte-level events); transcription is open-ended so we
// just slow-creep the bar up to ~92% and let success snap it to 100%.
function startLoader(sizeMB) {
  $("t-loader").classList.remove("hidden");
  const bar = $("t-progress-bar");
  const status = $("t-loader-status");
  bar.style.width = "0%";
  status.textContent = `Uploading ${sizeMB.toFixed(1)} MB…`;
  return { bar, status };
}
function stopLoader() {
  $("t-loader").classList.add("hidden");
}

function uploadWithProgress(url, fd, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    // auth.js patches window.fetch to add the bearer token, but XHR
    // bypasses that wrapper — pull the token from localStorage and
    // attach it ourselves so the backend doesn't 401 on big uploads.
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

// ---- Drag & drop wiring -------------------------------------------------
(function () {
  const dz = $("t-dropzone");
  const input = $("t-file");
  const nameEl = $("t-file-name");
  if (!dz || !input) return;

  function setFile(file) {
    if (!file) return;
    // Stuff the dropped file into the hidden <input> so the rest of the
    // page (the Transcribe click handler) works unchanged.
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
    } catch { /* programmatic file assignment can fail in some browsers; the file name still renders */ }
    const mb = (file.size / 1024 / 1024).toFixed(1);
    nameEl.textContent = `${file.name} · ${mb} MB`;
    nameEl.classList.add("has-file");
  }

  // Clicking anywhere in the dropzone opens the picker — except when the
  // click came from the input itself, otherwise we'd loop forever.
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

  // ---- In-browser recording -------------------------------------------
  // Captures mic audio straight into the form. On stop we turn the recorded
  // Blob into a File and push it through the exact same setFile() path an
  // uploaded file uses, so the rest of the page (selected-file label,
  // Transcribe submit, Title/Event/Day) works unchanged.
  const recStart = $("t-rec-start");
  const recStop = $("t-rec-stop");
  const recDiscard = $("t-rec-discard");
  const recIndicator = $("t-rec-indicator");
  const recTime = $("t-rec-time");
  const recStatus = $("t-rec-status");

  // Mirrors booth.js's pickMime(): prefer Opus-in-WebM, fall back through
  // formats the backend already accepts (webm/ogg/mp4→m4a).
  function pickRecMime() {
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
    for (const m of candidates) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch { /* ignore */ }
    }
    return "";
  }

  const recSupported =
    typeof navigator !== "undefined" &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined";

  if (!recSupported) {
    // No recording in this browser — hide the controls, keep upload intact.
    if (recStart) recStart.classList.add("hidden");
    if (recStatus) recStatus.textContent =
      "Recording isn't supported in this browser — drag in or browse for a file instead.";
  } else {
    let mediaRecorder = null;
    let recChunks = [];
    let recMime = "audio/webm";
    let recStream = null;
    let recStartedAt = 0;
    let recTimer = null;

    function fmtRecTime(ms) {
      const total = Math.floor(ms / 1000);
      const m = String(Math.floor(total / 60)).padStart(2, "0");
      const s = String(total % 60).padStart(2, "0");
      return `${m}:${s}`;
    }
    function extForMime(mime) {
      if (/ogg/.test(mime)) return "ogg";
      if (/mp4/.test(mime)) return "m4a";
      return "webm";
    }
    function stopTracks() {
      if (recStream) { recStream.getTracks().forEach((t) => t.stop()); recStream = null; }
    }

    recStart.addEventListener("click", async () => {
      const vrOk = window.VoiceReminder ? await window.VoiceReminder.guardRecording() : true;
      if (!vrOk) return;
      try {
        recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        showAlert("error",
          "Microphone access was blocked or unavailable — you can still drag in or browse for a file. (" + e.message + ")");
        return;
      }
      recMime = pickRecMime() || "audio/webm";
      try {
        mediaRecorder = new MediaRecorder(recStream, recMime ? { mimeType: recMime } : {});
      } catch (e) {
        stopTracks();
        showAlert("error", "Couldn't start the recorder: " + e.message);
        return;
      }
      recChunks = [];
      mediaRecorder.addEventListener("dataavailable", (e) => {
        if (e.data && e.data.size > 0) recChunks.push(e.data);
      });
      mediaRecorder.addEventListener("stop", () => {
        stopTracks();
        clearInterval(recTimer); recTimer = null;
        recIndicator.classList.add("hidden");
        const blob = new Blob(recChunks, { type: recMime });
        if (blob.size === 0) {
          showAlert("error", "Nothing was recorded — please try again.");
          recStart.classList.remove("hidden");
          recStop.classList.add("hidden");
          return;
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const file = new File([blob], `recording-${stamp}.${extForMime(recMime)}`, { type: recMime });
        setFile(file);
        recStart.textContent = "● Re-record";
        recStart.classList.remove("hidden");
        recStop.classList.add("hidden");
        recDiscard.classList.remove("hidden");
        recStatus.textContent = "Recording ready — press Transcribe, or discard to record again.";
      });

      showAlert(null);
      mediaRecorder.start();
      recStartedAt = Date.now();
      recTime.textContent = "00:00";
      recStart.classList.add("hidden");
      recDiscard.classList.add("hidden");
      recStop.classList.remove("hidden");
      recIndicator.classList.remove("hidden");
      recStatus.textContent = "Recording… press Stop when you're done.";
      recTimer = setInterval(() => {
        recTime.textContent = fmtRecTime(Date.now() - recStartedAt);
      }, 250);
    });

    recStop.addEventListener("click", () => {
      if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
    });

    recDiscard.addEventListener("click", () => {
      recChunks = [];
      try {
        const dt = new DataTransfer();
        input.files = dt.files;
      } catch { /* programmatic clear can fail in some browsers */ }
      nameEl.textContent = "No file selected yet";
      nameEl.classList.remove("has-file");
      recStart.textContent = "● Record audio";
      recDiscard.classList.add("hidden");
      recStatus.textContent = "";
    });
  }
})();

$("btn-transcribe").addEventListener("click", async () => {
  const f = $("t-file").files[0];
  if (!f) { showAlert("error", "Pick an audio file first."); return; }

  $("btn-transcribe").disabled = true;
  $("t-status").textContent = "";
  showAlert(null);
  const sizeMB = f.size / 1024 / 1024;
  const { bar, status } = startLoader(sizeMB);
  let creep = null;

  try {
    const fd = new FormData();
    fd.append("audio", f, f.name);
    const title = $("t-title").value.trim();
    if (title) fd.append("title", title);
    const eventDayId = $("t-day").value;
    if (eventDayId) fd.append("event_day_id", eventDayId);

    const data = await uploadWithProgress("/api/transcribe", fd, (frac) => {
      // First 60% of the bar = the actual upload progress.
      const pct = Math.min(60, Math.round(frac * 60));
      bar.style.width = pct + "%";
      if (frac >= 1) {
        status.textContent = "Transcribing audio…";
        // After upload completes, slow-creep from 60% to 92% so the user
        // sees movement while Deepgram/Whisper processes.
        let p = 60;
        creep = setInterval(() => {
          p = Math.min(92, p + 0.6);
          bar.style.width = p + "%";
        }, 350);
      }
    });
    if (creep) { clearInterval(creep); creep = null; }
    bar.style.width = "100%";
    status.textContent = "Done.";

    $("result-card").classList.remove("hidden");
    $("result-title").textContent = data.title || "Result";
    const temp = data.lead_temperature
      ? ` · <span class="temp ${esc(data.lead_temperature)}">${esc(data.lead_temperature)}</span>`
      : "";
    const score = data.lead_score != null ? ` · lead score ${data.lead_score}` : "";
    const eventBits = [];
    if (data.event_name) eventBits.push(esc(data.event_name));
    if (data.event_day_label) eventBits.push(esc(data.event_day_label));
    const eventTag = eventBits.length ? ` · <span class="pill">${eventBits.join(" · ")}</span>` : "";
    $("result-meta").innerHTML =
      `Saved as conversation #${data.conversation_id}${score}${temp}${eventTag}`;
    renderSpeakerSummary(data);
    $("result-transcript").textContent = data.transcript;
    $("result-link").href = "/dashboard";
    $("t-status").textContent = "";
    showAlert("success", "Transcribed and saved. It's on the dashboard.");
    setTimeout(stopLoader, 400);
  } catch (e) {
    if (creep) clearInterval(creep);
    stopLoader();
    showAlert("error", e.message);
  } finally {
    $("btn-transcribe").disabled = false;
  }
});
