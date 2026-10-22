"use strict";

function escapeHTML(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SOURCE_META = {
  intelligence: { label: "Intelligence" },
  imported: { label: "Imported" },
  zoom: { label: "Zoom" },
  google_meet: { label: "Google Meet" },
  microsoft_teams: { label: "Teams" },
};

function sourceLabel(src) {
  const m = SOURCE_META[src];
  return m ? m.label : (src || "Meeting");
}

function statusClass(status) {
  const s = String(status || "").toLowerCase();
  if (["queued", "running", "processing"].includes(s)) return "st-" + s;
  if (["completed", "failed", "scheduled"].includes(s)) return "st-" + s;
  return "";
}

function fmtDate(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) +
    " · " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

let currentSource = "";
let currentQuery = "";
let searchTimer = null;

function toast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2600);
}

function renderRows(meetings) {
  const table = document.getElementById("am-table");
  const empty = document.getElementById("am-empty");
  const emptyText = document.getElementById("am-empty-text");
  const tbody = document.getElementById("am-rows");

  if (!meetings.length) {
    table.style.display = "none";
    empty.style.display = "flex";
    emptyText.textContent = currentQuery || currentSource
      ? "No meetings match your filters."
      : "No meetings yet. Once you capture, import, or schedule meetings, they'll appear here.";
    tbody.innerHTML = "";
    return;
  }

  empty.style.display = "none";
  table.style.display = "table";

  tbody.innerHTML = meetings.map((m) => {
    const src = String(m.source || "");
    const stCls = statusClass(m.status);
    const stLabel = m.status ? escapeHTML(m.status) : "—";
    const parts = typeof m.participants === "number" && m.participants > 0
      ? escapeHTML(m.participants) + " participant" + (m.participants === 1 ? "" : "s")
      : "—";
    return (
      '<tr data-url="' + escapeHTML(m.detail_url || "") + '">' +
      '<td><div class="am-title">' + escapeHTML(m.title || "Untitled meeting") + "</div></td>" +
      '<td class="am-hide-sm"><span class="pill src-' + escapeHTML(src) + '">' + escapeHTML(sourceLabel(src)) + "</span></td>" +
      '<td class="am-hide-sm am-when">' + escapeHTML(fmtDate(m.date)) + "</td>" +
      '<td class="am-hide-sm am-parts">' + parts + "</td>" +
      "<td>" + (stCls ? '<span class="pill ' + stCls + '">' + stLabel + "</span>" : '<span class="muted">' + stLabel + "</span>") + "</td>" +
      '<td class="am-chevron">›</td>' +
      "</tr>"
    );
  }).join("");

  Array.from(tbody.querySelectorAll("tr")).forEach((tr) => {
    tr.addEventListener("click", () => {
      const url = tr.getAttribute("data-url");
      if (url) window.location.href = url;
    });
  });
}

async function load() {
  const empty = document.getElementById("am-empty");
  const emptyText = document.getElementById("am-empty-text");
  const table = document.getElementById("am-table");
  const params = new URLSearchParams();
  if (currentSource) params.set("source", currentSource);
  if (currentQuery) params.set("q", currentQuery);
  params.set("limit", "200");

  try {
    const res = await fetch("/api/meetings/all?" + params.toString());
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    renderRows(Array.isArray(data.meetings) ? data.meetings : []);
  } catch (e) {
    table.style.display = "none";
    empty.style.display = "flex";
    emptyText.textContent = "Couldn't load meetings. Please try again.";
    toast("Failed to load meetings.");
  }
}

function initChips() {
  const wrap = document.getElementById("am-chips");
  wrap.addEventListener("click", (e) => {
    const btn = e.target.closest(".am-chip");
    if (!btn) return;
    currentSource = btn.getAttribute("data-source") || "";
    Array.from(wrap.querySelectorAll(".am-chip")).forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
    load();
  });
}

function initSearch() {
  const input = document.getElementById("am-q");
  input.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      currentQuery = input.value.trim();
      load();
    }, 260);
  });
}

// ---- Import Conversation panel ------------------------------------------
function initImportTabs() {
  const tabs = document.getElementById("ic-tabs");
  const panes = Array.from(document.querySelectorAll(".ic-pane"));
  tabs.addEventListener("click", (e) => {
    const btn = e.target.closest(".ic-tab");
    if (!btn) return;
    const tab = btn.getAttribute("data-tab");
    Array.from(tabs.querySelectorAll(".ic-tab")).forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    panes.forEach((p) => p.classList.toggle("active", p.getAttribute("data-pane") === tab));
  });
}

async function loadProviderStatus() {
  const bodies = Array.from(document.querySelectorAll(".ic-prov-body"));
  const labels = { zoom: "Zoom", google_meet: "Google Meet", ms_teams: "Microsoft Teams" };
  let providers = [];
  try {
    const res = await fetch("/api/imported-meetings/providers/status");
    if (res.ok) {
      const data = await res.json();
      providers = Array.isArray(data.providers) ? data.providers : [];
    }
  } catch (e) { /* leave defaults */ }

  const byKey = {};
  providers.forEach((p) => { byKey[p.provider] = p; });

  document.querySelectorAll(".ic-dot").forEach((dot) => {
    const p = byKey[dot.getAttribute("data-prov")];
    dot.classList.toggle("on", !!(p && p.connected));
  });

  bodies.forEach((el) => {
    const key = el.getAttribute("data-prov");
    const p = byKey[key];
    const label = escapeHTML(labels[key] || key);
    if (p && p.connected) {
      el.innerHTML = label + " is connected. Scheduled and imported " + label +
        " meetings appear in the list below. <a href=\"/imported-meetings\">Manage " + label + " →</a>";
    } else {
      el.innerHTML = "Connect " + label +
        " to bring in scheduled meetings automatically. <a href=\"/imported-meetings\">Connect " + label + " →</a>";
    }
  });
}

function initAudioTab() {
  const $ = (id) => document.getElementById(id);
  const fileInput = $("ic-file");
  const dz = $("ic-dropzone");
  const nameEl = $("ic-file-name");
  const out = $("ic-out");
  const recStart = $("ic-rec-start");
  const recStop = $("ic-rec-stop");
  const recDiscard = $("ic-rec-discard");
  const recIndicator = $("ic-rec-indicator");
  const recTime = $("ic-rec-time");
  const recStatus = $("ic-rec-status");

  const MAX_MB = 2048; // matches backend /api/transcribe MAX_MB cap

  function isAudio(file) {
    return /^audio\//.test(file.type) || /\.(wav|mp3|m4a|mp4|webm|ogg|flac)$/i.test(file.name);
  }

  // Validate + register a file for both the browse and drag/drop paths.
  function setFile(file) {
    if (!file) return false;
    if (!isAudio(file)) {
      out.innerHTML = '<div class="err">That doesn\'t look like an audio file (.mp3, .m4a, .wav, .webm…).</div>';
      return false;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      out.innerHTML = '<div class="err">That file is too large — the limit is ' + MAX_MB + ' MB.</div>';
      return false;
    }
    out.innerHTML = "";
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
    } catch (e) { /* programmatic assignment can fail in some browsers */ }
    const mb = (file.size / 1024 / 1024).toFixed(1);
    nameEl.textContent = file.name + " · " + mb + " MB";
    nameEl.classList.add("has-file");
    return true;
  }

  dz.addEventListener("click", (e) => { if (e.target !== fileInput) fileInput.click(); });
  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener("change", () => {
    const f = fileInput.files && fileInput.files[0];
    if (f && !setFile(f)) {
      try { fileInput.files = new DataTransfer().files; } catch (e) { /* ignore */ }
      nameEl.textContent = "No file selected yet";
      nameEl.classList.remove("has-file");
    }
  });
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation(); dz.classList.add("drag");
  }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation(); dz.classList.remove("drag");
  }));
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) setFile(f);
  });

  // In-browser recording (mirrors booth.js / transcribe.js MediaRecorder flow).
  const recSupported = typeof navigator !== "undefined" && navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function" && typeof MediaRecorder !== "undefined";

  if (!recSupported) {
    recStart.classList.add("hidden");
    recStatus.textContent = "Recording isn't supported in this browser — drop or browse for a file instead.";
  } else {
    let mediaRecorder = null;
    let recChunks = [];
    let recMime = "audio/webm";
    let recStream = null;
    let recStartedAt = 0;
    let recTimer = null;

    function pickRecMime() {
      const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
      for (const m of candidates) {
        try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* ignore */ }
      }
      return "";
    }
    function extForMime(mime) {
      if (/ogg/.test(mime)) return "ogg";
      if (/mp4/.test(mime)) return "m4a";
      return "webm";
    }
    function fmtRecTime(ms) {
      const total = Math.floor(ms / 1000);
      const m = String(Math.floor(total / 60)).padStart(2, "0");
      const s = String(total % 60).padStart(2, "0");
      return m + ":" + s;
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
        out.innerHTML = '<div class="err">Microphone access was blocked or unavailable — drop or browse for a file instead.</div>';
        return;
      }
      recMime = pickRecMime() || "audio/webm";
      try {
        mediaRecorder = new MediaRecorder(recStream, recMime ? { mimeType: recMime } : {});
      } catch (e) {
        stopTracks();
        out.innerHTML = '<div class="err">Couldn\'t start the recorder: ' + escapeHTML(e.message) + "</div>";
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
          out.innerHTML = '<div class="err">Nothing was recorded — please try again.</div>';
          recStart.classList.remove("hidden");
          recStop.classList.add("hidden");
          return;
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const file = new File([blob], "recording-" + stamp + "." + extForMime(recMime), { type: recMime });
        setFile(file);
        recStart.textContent = "● Re-record";
        recStart.classList.remove("hidden");
        recStop.classList.add("hidden");
        recDiscard.classList.remove("hidden");
        recStatus.textContent = "Recording ready — press Transcribe & save, or discard to record again.";
      });

      out.innerHTML = "";
      mediaRecorder.start();
      recStartedAt = Date.now();
      recTime.textContent = "00:00";
      recStart.classList.add("hidden");
      recDiscard.classList.add("hidden");
      recStop.classList.remove("hidden");
      recIndicator.classList.remove("hidden");
      recStatus.textContent = "Recording… press Stop when you're done.";
      recTimer = setInterval(() => { recTime.textContent = fmtRecTime(Date.now() - recStartedAt); }, 250);
    });

    recStop.addEventListener("click", () => {
      if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
    });
    recDiscard.addEventListener("click", () => {
      recChunks = [];
      try { fileInput.files = new DataTransfer().files; } catch (e) { /* ignore */ }
      nameEl.textContent = "No file selected yet";
      nameEl.classList.remove("has-file");
      recStart.textContent = "● Record audio";
      recDiscard.classList.add("hidden");
      recStatus.textContent = "";
    });
  }

  // Upload — XHR so we can attach the bearer token (auth.js only patches fetch)
  // and drive a real progress bar.
  function uploadWithProgress(url, fd, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      try {
        const token = localStorage.getItem("booth_auth_token");
        if (token) xhr.setRequestHeader("Authorization", "Bearer " + token);
      } catch (e) { /* private mode — let server 401 */ }
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      });
      xhr.onload = () => {
        let body = {};
        try { body = JSON.parse(xhr.responseText); } catch (e) { /* non-JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body.detail || "Failed (" + xhr.status + ")"));
      };
      xhr.onerror = () => reject(new Error("Network error during upload"));
      xhr.send(fd);
    });
  }

  $("ic-transcribe").addEventListener("click", async () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) { out.innerHTML = '<div class="err">Record or pick an audio file first.</div>'; return; }
    const btn = $("ic-transcribe");
    const prog = $("ic-progress");
    const bar = $("ic-progress-bar");
    btn.disabled = true;
    out.innerHTML = "";
    prog.classList.remove("hidden");
    bar.style.width = "0%";
    let creep = null;
    try {
      const fd = new FormData();
      fd.append("audio", f, f.name);
      const title = $("ic-title").value.trim();
      if (title) fd.append("title", title);
      const data = await uploadWithProgress("/api/transcribe", fd, (frac) => {
        const pct = Math.min(60, Math.round(frac * 60));
        bar.style.width = pct + "%";
        if (frac >= 1 && !creep) {
          let p = 60;
          creep = setInterval(() => { p = Math.min(92, p + 0.6); bar.style.width = p + "%"; }, 350);
        }
      });
      if (creep) { clearInterval(creep); creep = null; }
      bar.style.width = "100%";
      const cid = data.conversation_id;
      out.innerHTML = '<div class="ok">Transcribed and saved' +
        (cid != null ? " as conversation #" + escapeHTML(cid) : "") +
        '. <a href="/dashboard">View on dashboard →</a></div>';
      toast("Conversation saved.");
      load();
    } catch (e) {
      if (creep) clearInterval(creep);
      out.innerHTML = '<div class="err">' + escapeHTML(e.message) + "</div>";
    } finally {
      btn.disabled = false;
      setTimeout(() => prog.classList.add("hidden"), 600);
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initChips();
  initSearch();
  initImportTabs();
  initAudioTab();
  loadProviderStatus();
  load();
});
