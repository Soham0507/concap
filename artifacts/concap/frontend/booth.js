// Booth capture flow: register -> record -> submit
// All captures go through the IDB queue. If the network is up the queue
// drains immediately; otherwise the capture sits in IndexedDB until it can.

import { Queue, drainQueue, installDrainTriggers } from "/static/queue.js";

const STEPS = ["register", "record", "done"];

const state = {
  config: null,
  recorder: null,
  chunks: [],
  audioBlob: null,
  audioMime: "audio/webm",
  startedAt: null,
  timerInterval: null,
  // Company directory for the booth's typeahead. Loaded once at boot and
  // refreshed whenever a capture submits (since the pipeline can auto-link
  // and the user may want a freshly created company to appear next time).
  companies: [],
};

const $ = (id) => document.getElementById(id);

function showAlert(kind, msg) {
  const el = $("alert");
  if (!msg) { el.innerHTML = ""; return; }
  el.innerHTML = `<div class="alert ${kind}">${msg}</div>`;
}

function gotoStep(step) {
  STEPS.forEach((s) => {
    $(`card-${s}`).classList.toggle("hidden", s !== step);
  });
  document.querySelectorAll(".step").forEach((el) => {
    const name = el.dataset.step;
    el.classList.remove("active", "done");
    if (STEPS.indexOf(name) < STEPS.indexOf(step)) el.classList.add("done");
    if (name === step) el.classList.add("active");
  });
  showAlert(null);
}

async function loadConfig() {
  try {
    const r = await fetch("/api/config");
    state.config = await r.json();
    const sub = $("event-subtitle");
    if (sub) sub.textContent = `${state.config.booth_name} · ${state.config.event_name}`;
    const brandSub = $("brand-subtitle");
    if (brandSub) brandSub.textContent = state.config.booth_name;
  } catch {
    state.config = { booth_name: "Booth", event_name: "Event" };
  }
}

async function loadCompanies() {
  // Best-effort: the booth still works fully if this fails (the user can
  // type a free-text company name and the server will create one downstream).
  try {
    const r = await fetch("/api/companies");
    if (!r.ok) return;
    state.companies = await r.json();
    refreshCompanySuggestions();
  } catch {
    // ignore — offline / not signed in / etc.
  }
}

function refreshCompanySuggestions() {
  const dl = $("company-suggestions");
  if (!dl) return;
  // datalist gives free typeahead + free-text typing without bespoke UI.
  // Sort alphabetically so the dropdown is predictable across refreshes.
  const opts = [...state.companies]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => `<option value="${escapeAttr(c.name)}"></option>`);
  dl.innerHTML = opts.join("");
}

function escapeAttr(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function resolveCompanyIdFromInput() {
  // Match the typed text against the loaded directory, case-insensitive.
  // We only set company_id when there's an exact match — partial / typo'd
  // names fall through to the server's find-or-create-via-string path so
  // we never link to the wrong account just because the names look close.
  const typed = $("v-company").value.trim().toLowerCase();
  if (!typed) return null;
  const hit = state.companies.find((c) => c.name.trim().toLowerCase() === typed);
  return hit ? hit.id : null;
}

function updateCompanyHint() {
  const hint = $("v-company-hint");
  if (!hint) return;
  const typed = $("v-company").value.trim();
  if (!typed) {
    hint.textContent = "Picking an existing company links this transcript directly to it.";
    hint.style.color = "";
    return;
  }
  const id = resolveCompanyIdFromInput();
  if (id != null) {
    hint.textContent = `✓ Linking to existing company "${typed}".`;
    hint.style.color = "var(--success, #2da44e)";
  } else {
    hint.textContent = `New company "${typed}" will be created and linked.`;
    hint.style.color = "var(--text-muted)";
  }
}

$("btn-record-back").addEventListener("click", () => gotoStep("register"));
$("v-company").addEventListener("input", updateCompanyHint);
$("v-company").addEventListener("change", updateCompanyHint);

$("btn-register-next").addEventListener("click", () => {
  const name = $("v-name").value.trim();
  if (!name) {
    showAlert("error", "Visitor name is required.");
    return;
  }
  gotoStep("record");
  $("record-visitor-line").textContent =
    `${name}${$("v-company").value.trim() ? " · " + $("v-company").value.trim() : ""}`;
});

function fmtTimer(ms) {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function pickMime() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  for (const m of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

$("btn-record").addEventListener("click", async () => {
  const btn = $("btn-record");
  if (state.recorder && state.recorder.state === "recording") {
    state.recorder.stop();
    return;
  }

  // Nudge first-time recorders to set up a Voice Profile (once per session).
  const vrOk = window.VoiceReminder ? await window.VoiceReminder.guardRecording() : true;
  if (!vrOk) return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = pickMime();
    state.audioMime = mime || "audio/webm";
    state.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    state.chunks = [];

    state.recorder.addEventListener("dataavailable", (e) => {
      if (e.data && e.data.size > 0) state.chunks.push(e.data);
    });
    state.recorder.addEventListener("stop", () => {
      state.audioBlob = new Blob(state.chunks, { type: state.audioMime });
      stream.getTracks().forEach((t) => t.stop());
      btn.classList.remove("recording");
      clearInterval(state.timerInterval);
      const playback = $("playback");
      playback.src = URL.createObjectURL(state.audioBlob);
      playback.classList.remove("hidden");
      $("record-status").textContent =
        `Captured ${(state.audioBlob.size / 1024).toFixed(0)} KB. Ready to submit.`;
      $("btn-submit").disabled = false;
    });

    state.recorder.start(1000);
    state.startedAt = Date.now();
    $("timer").textContent = "00:00";
    btn.classList.add("recording");
    $("record-status").textContent = "Recording… tap the button again to stop.";
    $("btn-submit").disabled = true;
    state.timerInterval = setInterval(() => {
      $("timer").textContent = fmtTimer(Date.now() - state.startedAt);
    }, 250);
  } catch (e) {
    showAlert("error", "Microphone access denied or unavailable. " + e.message);
  }
});

$("btn-submit").addEventListener("click", async () => {
  if (!state.audioBlob) return;
  $("btn-submit").disabled = true;
  showAlert("info", "Queueing capture…");

  const visitor = {
    name: $("v-name").value.trim(),
    company: $("v-company").value.trim() || null,
    email: $("v-email").value.trim() || null,
    phone: $("v-phone").value.trim() || null,
    designation: $("v-designation").value.trim() || null,
    industry: $("v-industry").value.trim() || null,
    interest_category: $("v-interest").value.trim() || null,
    source: "manual",
  };

  // If the typed company name matches an existing one exactly, pass its id
  // through to the server so the conversation is linked directly (not just
  // transitively via the visitor's company string).
  const companyId = resolveCompanyIdFromInput();

  try {
    const captureId = await Queue.enqueue({
      visitor,
      companyId,
      consent: null,
      staffName: $("v-staff").value.trim() || null,
      audioBlob: state.audioBlob,
      audioMime: state.audioMime,
    });

    const result = await drainQueue({ onChange: refreshQueueIndicator });

    gotoStep("done");
    const sent = result.drained > 0;
    $("done-msg").textContent = sent
      ? "Capture submitted. The AI is processing it now."
      : "No network right now. Capture saved on this device and will upload automatically when connectivity returns.";
    $("done-details").innerHTML = `
      <div class="muted">Local capture ID: <code>${captureId}</code></div>
      <div class="muted">${result.remaining} pending capture(s) in the local queue.</div>
    `;
    refreshQueueIndicator();
    // Refresh the directory so any newly-created company shows up next time.
    loadCompanies();
  } catch (e) {
    $("btn-submit").disabled = false;
    showAlert("error", "Failed to queue capture: " + e.message);
  }
});

$("btn-new").addEventListener("click", () => {
  state.audioBlob = null;
  state.chunks = [];
  ["v-name", "v-company", "v-email", "v-phone", "v-designation", "v-industry", "v-interest"].forEach(
    (id) => ($(id).value = "")
  );
  $("timer").textContent = "00:00";
  $("playback").classList.add("hidden");
  $("playback").src = "";
  $("btn-submit").disabled = true;
  updateCompanyHint();
  gotoStep("register");
});

// -- Offline status + queue indicator --------------------------------------

async function refreshQueueIndicator() {
  const pending = await Queue.count("pending");
  const sending = await Queue.count("sending");
  const failed = await Queue.count("failed");
  const total = pending + sending;

  // Sidebar footer: status dot + label.
  const dot = $("conn-dot");
  const text = $("conn-text");
  if (dot && text) {
    if (navigator.onLine) {
      dot.classList.remove("offline");
      text.textContent = "online";
    } else {
      dot.classList.add("offline");
      text.textContent = "offline";
    }
  }

  const queueEl = $("queue-pill");
  if (!queueEl) return;
  if (total === 0 && failed === 0) {
    queueEl.classList.add("hidden");
  } else {
    queueEl.classList.remove("hidden");
    const parts = [];
    if (total > 0) parts.push(`${total} queued`);
    if (failed > 0) parts.push(`${failed} failed`);
    queueEl.textContent = parts.join(" · ");
    queueEl.className = "pill " + (failed > 0 ? "error" : "info") + (queueEl.classList.contains("hidden") ? " hidden" : "");
  }
}

window.addEventListener("online", refreshQueueIndicator);
window.addEventListener("offline", refreshQueueIndicator);

// -- Service Worker registration -------------------------------------------

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => {
    console.warn("Service Worker registration failed:", err);
  });
}

// -- Boot ------------------------------------------------------------------

loadConfig();
loadCompanies();
installDrainTriggers({ onChange: refreshQueueIndicator });
refreshQueueIndicator();
setInterval(refreshQueueIndicator, 5000);
