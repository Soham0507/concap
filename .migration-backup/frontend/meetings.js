/* Meeting Intelligence page.
 *
 * Three jobs:
 *   1. Intake — paste a single transcript (POST /process) or upload a bulk
 *      batch of text/audio files (POST /batches/upload).
 *   2. History — list batches and standalone documents, poll while any are
 *      still queued/running/processing.
 *   3. Detail — for a batch, show the combined cross-meeting summary (with
 *      evidence quotes + source counts) and an expandable list of per-meeting
 *      minutes; for a single doc, show its minutes directly.
 *
 * All API calls go through auth.js's patched fetch (bearer token attached).
 */
const API = "/api/meetings/intelligence";
const $ = (id) => document.getElementById(id);

let BATCHES = [];
let DOCS = [];          // standalone (no batch) documents
let selected = null;    // { kind: "batch"|"doc", id }
let pollTimer = null;
let pickedFiles = [];

const ACTIVE = new Set(["queued", "running", "processing"]);

function escapeHTML(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function parseServerDate(iso) {
  if (!iso) return null;
  const s = /[zZ]|[+\-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "Z";
  const d = new Date(s);
  return isNaN(d) ? null : d;
}
function fmtDate(iso) {
  const d = parseServerDate(iso);
  if (!d) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    ", " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

async function api(path, opts) {
  const res = await fetch(API + path, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-json */ }
  if (!res.ok) {
    const detail = (data && (data.detail || data.message)) || ("Request failed (" + res.status + ")");
    const err = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    err.status = res.status;
    throw err;
  }
  return data;
}

// --- intake: tab switching ------------------------------------------------
function wireTabs() {
  document.querySelectorAll(".intake-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".intake-tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".intake-pane").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      const pane = document.querySelector('.intake-pane[data-pane="' + tab.dataset.tab + '"]');
      if (pane) pane.classList.add("active");
    });
  });
}

// --- intake: single paste -------------------------------------------------
async function processPaste() {
  const text = $("m-text").value.trim();
  if (text.length < 20) { toast("Transcript needs at least 20 characters."); return; }
  const btn = $("btn-process");
  btn.disabled = true; btn.textContent = "Submitting…";
  try {
    const doc = await api("/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript_text: text,
        meeting_source: $("m-source").value.trim() || "manual",
        project_name: $("m-project").value.trim() || null,
      }),
    });
    $("m-text").value = "";
    toast("Queued — generating minutes…");
    await loadHistory();
    selectDoc(doc.id);
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false; btn.textContent = "Generate minutes";
  }
}

// --- intake: bulk upload --------------------------------------------------
function renderPicked() {
  const ul = $("dz-files");
  ul.innerHTML = "";
  pickedFiles.forEach((f, i) => {
    const li = document.createElement("li");
    const kb = f.size > 1024 * 1024
      ? (f.size / 1024 / 1024).toFixed(1) + " MB"
      : Math.max(1, Math.round(f.size / 1024)) + " KB";
    li.innerHTML = '<span>' + escapeHTML(f.name) + ' <span class="muted">· ' + kb + '</span></span>' +
      '<span class="rm" data-i="' + i + '">remove</span>';
    ul.appendChild(li);
  });
  ul.querySelectorAll(".rm").forEach((x) => x.addEventListener("click", () => {
    pickedFiles.splice(Number(x.dataset.i), 1);
    renderPicked();
  }));
}

function wireDropzone() {
  const dz = $("dropzone");
  const input = $("file-input");
  dz.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    pickedFiles = pickedFiles.concat(Array.from(input.files));
    input.value = "";
    renderPicked();
  });
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault(); dz.classList.add("drag");
  }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault(); dz.classList.remove("drag");
  }));
  dz.addEventListener("drop", (e) => {
    if (e.dataTransfer && e.dataTransfer.files) {
      pickedFiles = pickedFiles.concat(Array.from(e.dataTransfer.files));
      renderPicked();
    }
  });
}

async function uploadBatch() {
  if (!pickedFiles.length) { toast("Add at least one file."); return; }
  const btn = $("btn-upload");
  btn.disabled = true; btn.textContent = "Uploading…";
  try {
    const fd = new FormData();
    pickedFiles.forEach((f) => fd.append("files", f));
    const label = $("m-label").value.trim();
    if (label) fd.append("label", label);
    const source = $("m-source").value.trim();
    if (source) fd.append("meeting_source", source);
    const project = $("m-project").value.trim();
    if (project) fd.append("project_name", project);

    const res = await api("/batches/upload", { method: "POST", body: fd });
    pickedFiles = []; renderPicked();
    $("m-label").value = "";
    let msg = "Batch queued — " + res.enqueued + " file(s) processing.";
    if (res.skipped && res.skipped.length) msg += " Skipped " + res.skipped.length + ".";
    toast(msg);
    await loadHistory();
    if (res.batch) selectBatch(res.batch.id);
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false; btn.textContent = "Upload & process batch";
  }
}

// --- history --------------------------------------------------------------
async function loadHistory() {
  try {
    const [batches, docs] = await Promise.all([
      api("/batches?limit=100"),
      api("/documents?limit=100"),
    ]);
    BATCHES = batches || [];
    DOCS = (docs || []).filter((d) => !d.batch_id); // standalone only
    renderHistory();
    schedulePoll();
  } catch (e) {
    $("batch-status").textContent = e.message;
  }
}

function renderHistory() {
  const list = $("batch-list");
  list.innerHTML = "";
  const rows = [];

  BATCHES.forEach((b) => rows.push({ kind: "batch", id: b.id, sort: b.created_at, data: b }));
  DOCS.forEach((d) => rows.push({ kind: "doc", id: d.id, sort: d.created_at, data: d }));
  rows.sort((a, c) => (parseServerDate(c.sort) || 0) - (parseServerDate(a.sort) || 0));

  if (!rows.length) {
    $("batch-status").textContent = "No meetings yet. Paste a transcript or upload files to begin.";
    return;
  }
  $("batch-status").textContent = "";

  rows.forEach((r) => {
    const el = document.createElement("div");
    el.className = "batch-row";
    if (selected && selected.kind === r.kind && selected.id === r.id) el.classList.add("selected");

    if (r.kind === "batch") {
      const b = r.data;
      const done = b.completed_count + b.failed_count;
      const pct = b.total_count ? Math.round((done / b.total_count) * 100) : 0;
      el.innerHTML =
        '<div class="br-top"><span class="br-label">' + escapeHTML(b.label || ("Batch #" + b.id)) + '</span>' +
        '<span class="br-when">' + fmtDate(b.created_at) + '</span></div>' +
        '<div class="br-meta">' + b.total_count + ' meeting(s) · ' + b.completed_count + ' done' +
        (b.failed_count ? ' · ' + b.failed_count + ' failed' : '') + '</div>' +
        (ACTIVE.has(b.status)
          ? '<div class="progress"><span style="width:' + pct + '%"></span></div>'
          : '<span class="pill ' + b.status + '">' + b.status + '</span>');
      el.addEventListener("click", () => selectBatch(b.id));
    } else {
      const d = r.data;
      el.innerHTML =
        '<div class="br-top"><span class="br-label">' + escapeHTML(d.meeting_title || d.transcript_id || ("Meeting #" + d.id)) + '</span>' +
        '<span class="br-when">' + fmtDate(d.created_at) + '</span></div>' +
        '<div class="br-meta">' + escapeHTML(d.meeting_source || "—") + (d.has_audio ? ' · audio' : '') + '</div>' +
        '<span class="pill ' + d.status + '">' + d.status + '</span>';
      el.addEventListener("click", () => selectDoc(d.id));
    }
    list.appendChild(el);
  });
}

function anyActive() {
  return BATCHES.some((b) => ACTIVE.has(b.status)) || DOCS.some((d) => ACTIVE.has(d.status));
}
function schedulePoll() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  const detailActive = selected && document.querySelector(".pill.queued, .pill.running, .pill.processing");
  if (anyActive() || detailActive) {
    pollTimer = setTimeout(refreshAll, 3500);
  }
}
async function refreshAll() {
  await loadHistory();
  if (selected) {
    if (selected.kind === "batch") await openBatch(selected.id, true);
    else await openDoc(selected.id, true);
  }
}

// --- selection ------------------------------------------------------------
function selectBatch(id) { selected = { kind: "batch", id }; renderHistory(); openBatch(id); }
function selectDoc(id) { selected = { kind: "doc", id }; renderHistory(); openDoc(id); }

function showDetail(html) {
  $("detail-empty").classList.add("hidden");
  const body = $("detail-body");
  body.classList.remove("hidden");
  body.innerHTML = html;
}

// --- batch detail (summary + documents) -----------------------------------
let batchTab = "summary";
async function openBatch(id, silent) {
  try {
    const [detail, summary] = await Promise.all([
      api("/batches/" + id),
      api("/batches/" + id + "/summary"),
    ]);
    renderBatch(detail, summary);
    schedulePoll();
  } catch (e) {
    if (!silent) showDetail('<div class="err-box">' + escapeHTML(e.message) + '</div>');
  }
}

function renderBatch(detail, summary) {
  const b = detail.batch;
  const docs = detail.documents || [];
  const hasFailed = docs.some((d) => d.status === "failed");

  let head =
    '<div class="detail-head"><h2>' + escapeHTML(b.label || ("Batch #" + b.id)) + '</h2>' +
    '<span class="pill ' + b.status + '">' + b.status + '</span></div>' +
    '<div class="detail-sub">' + b.total_count + ' meeting(s) · ' + b.completed_count +
    ' completed' + (b.failed_count ? ' · ' + b.failed_count + ' failed' : '') +
    ' · ' + fmtDate(b.created_at) + '</div>';

  if (hasFailed) {
    head += '<div class="btn-row" style="margin-bottom:16px;">' +
      '<button class="btn-ghost" id="btn-retry">Retry failed</button></div>';
  }

  const seg =
    '<div class="seg">' +
    '<button data-seg="summary" class="' + (batchTab === "summary" ? "active" : "") + '">Combined summary</button>' +
    '<button data-seg="docs" class="' + (batchTab === "docs" ? "active" : "") + '">Minutes (' + docs.length + ')</button>' +
    '</div>';

  const pane = batchTab === "summary"
    ? renderSummary(summary)
    : docs.map(renderDocItem).join("") || '<p class="muted">No meetings in this batch.</p>';

  showDetail(head + seg + '<div id="seg-pane">' + pane + '</div>');

  document.querySelectorAll(".seg button").forEach((btn) => btn.addEventListener("click", () => {
    batchTab = btn.dataset.seg;
    renderBatch(detail, summary);
  }));
  const retry = $("btn-retry");
  if (retry) retry.addEventListener("click", async () => {
    retry.disabled = true; retry.textContent = "Retrying…";
    try {
      const r = await api("/batches/" + b.id + "/retry", { method: "POST" });
      toast(r.requeued ? "Requeued " + r.requeued + " meeting(s)." : "Nothing to retry (max attempts reached).");
      await refreshAll();
    } catch (e) { toast(e.message); retry.disabled = false; retry.textContent = "Retry failed"; }
  });
  wireDocToggles();
}

function renderSummary(summary) {
  if (!summary || !summary.summary) return '<p class="muted">Summary unavailable.</p>';
  const s = summary.summary;
  if (!s.total_docs) {
    return '<p class="muted">The combined summary appears once at least one meeting in this batch finishes processing.</p>';
  }

  let html = '<div class="summary-card">' +
    '<h3>Overview</h3>' +
    '<div class="agg-meta">' +
    '<span>' + s.total_docs + ' meeting(s) summarised</span>' +
    '<span>Confidence ' + Math.round((s.confidence || 0) * 100) + '%</span>' +
    '<span>' + s.cited_count + ' point(s) with evidence quotes</span>' +
    '</div></div>';

  if (s.executive_summaries && s.executive_summaries.length) {
    html += '<div class="summary-card"><h3>Executive summaries</h3>';
    s.executive_summaries.forEach((e) => {
      html += '<div class="agg-item"><div class="agg-text">' + escapeHTML(e.summary) + '</div>' +
        '<div class="agg-meta"><span>' + escapeHTML(e.meeting_title || e.transcript_id || "Meeting") + '</span></div></div>';
    });
    html += '</div>';
  }

  html += renderActionItems(s.action_items);
  html += renderAggSection("Decisions", s.decisions_taken);
  html += renderAggSection("Discussion points", s.discussion_points);
  html += renderAggSection("Risks", s.risks);
  html += renderAggSection("Pending clarifications", s.pending_clarifications);
  html += renderAggSection("Next steps", s.next_steps);
  return html;
}

function renderSources(sources) {
  let out = "";
  (sources || []).forEach((src) => {
    if (!src.quote) return;
    out += '<div class="quote">“' + escapeHTML(src.quote) + '”' +
      '<span class="q-src">— ' + escapeHTML(src.meeting_title || src.transcript_id || "Meeting") + '</span></div>';
  });
  return out;
}

function renderAggSection(title, items) {
  if (!items || !items.length) return "";
  let html = '<div class="summary-card"><h3>' + escapeHTML(title) + '</h3>';
  items.forEach((it) => {
    html += '<div class="agg-item"><div class="agg-text">' + escapeHTML(it.text) +
      (it.sources.length > 1 ? ' <span class="src-count">' + it.sources.length + ' meetings</span>' : '') +
      '</div>' + renderSources(it.sources) + '</div>';
  });
  return html + '</div>';
}

function renderActionItems(items) {
  if (!items || !items.length) return "";
  let html = '<div class="summary-card"><h3>Action items</h3>';
  items.forEach((a) => {
    html += '<div class="agg-item"><div class="agg-text agg-task">' + escapeHTML(a.task) +
      (a.sources.length > 1 ? ' <span class="src-count">' + a.sources.length + ' meetings</span>' : '') + '</div>' +
      '<div class="agg-meta"><span>Owner: ' + escapeHTML(a.owner) + '</span>' +
      '<span>Due: ' + escapeHTML(a.deadline) + '</span>' +
      '<span>Status: ' + escapeHTML(a.status) + '</span></div>' +
      renderSources(a.sources) + '</div>';
  });
  return html + '</div>';
}

// --- per-document minutes -------------------------------------------------
function renderDocItem(d) {
  const title = escapeHTML(d.meeting_title || d.transcript_id || ("Meeting #" + d.id));
  const sub = escapeHTML(d.meeting_source || "—") + (d.has_audio ? " · audio" : "") +
    (d.confidence_score != null ? " · " + Math.round(d.confidence_score * 100) + "% confidence" : "");
  return '<div class="doc-item" data-doc="' + d.id + '">' +
    '<div class="doc-head"><div><div class="dh-title">' + title + '</div>' +
    '<div class="dh-sub">' + sub + '</div></div>' +
    '<span class="pill ' + d.status + '">' + d.status + '</span></div>' +
    '<div class="doc-body" id="docbody-' + d.id + '">' + renderDocBody(d) + '</div></div>';
}

function renderDocBody(d) {
  if (d.status === "failed") {
    return '<div class="err-box">' + escapeHTML(d.error_message || "Processing failed.") + '</div>' +
      '<div class="btn-row" style="margin-top:10px;"><button class="btn-ghost" data-reprocess="' + d.id + '">Reprocess</button></div>';
  }
  if (d.status !== "completed") {
    return '<p class="muted">Still processing — minutes will appear here once finished.</p>';
  }
  const md = d.document_markdown ? mdToHtml(d.document_markdown) : '<p class="muted">No minutes produced.</p>';
  return renderSourceSummary(d) + '<div class="mom">' + md + '</div>' +
    '<div class="btn-row" style="margin-top:12px;"><button class="btn-ghost" data-reprocess="' + d.id + '">Reprocess</button></div>';
}

// Show the source system's own summary (e.g. Plaud's AI note) above our MOM.
function renderSourceSummary(d) {
  if (!d.source_summary) return "";
  const label = (d.meeting_source === "plaud") ? "Plaud summary" : "Source summary";
  return '<details class="source-summary" style="margin-bottom:12px; padding:10px 12px; border:1px solid var(--border); border-radius:8px; background:var(--surface-alt);">' +
    '<summary style="cursor:pointer; font-weight:600;">' + escapeHTML(label) + '</summary>' +
    '<div class="mom" style="margin-top:8px;">' + mdToHtml(d.source_summary) + '</div></details>';
}

function wireDocToggles() {
  document.querySelectorAll(".doc-head").forEach((h) => h.addEventListener("click", () => {
    const body = h.parentNode.querySelector(".doc-body");
    if (body) body.classList.toggle("open");
  }));
  document.querySelectorAll("[data-reprocess]").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    b.disabled = true; b.textContent = "Reprocessing…";
    try {
      await api("/documents/" + b.dataset.reprocess + "/reprocess", { method: "POST" });
      toast("Reprocessing…");
      await refreshAll();
    } catch (err) { toast(err.message); b.disabled = false; b.textContent = "Reprocess"; }
  }));
}

// --- single document detail -----------------------------------------------
async function openDoc(id, silent) {
  try {
    const d = await api("/documents/" + id);
    const head =
      '<div class="detail-head"><h2>' + escapeHTML(d.meeting_title || d.transcript_id || ("Meeting #" + d.id)) + '</h2>' +
      '<span class="pill ' + d.status + '">' + d.status + '</span></div>' +
      '<div class="detail-sub">' + escapeHTML(d.meeting_source || "—") +
      (d.has_audio ? " · audio" : "") +
      (d.confidence_score != null ? " · " + Math.round(d.confidence_score * 100) + "% confidence" : "") +
      ' · ' + fmtDate(d.created_at) + '</div>';

    let body;
    if (d.status === "failed") {
      body = '<div class="err-box">' + escapeHTML(d.error_message || "Processing failed.") + '</div>' +
        '<div class="btn-row" style="margin-top:12px;"><button class="btn-ghost" data-reprocess="' + d.id + '">Reprocess</button></div>';
    } else if (d.status !== "completed") {
      body = '<p class="muted">Still processing — minutes will appear here once finished. This view refreshes automatically.</p>';
    } else {
      const md = d.document_markdown ? mdToHtml(d.document_markdown) : '<p class="muted">No minutes produced.</p>';
      body = renderSourceSummary(d) + '<div class="mom">' + md + '</div>' +
        '<div class="btn-row" style="margin-top:14px;"><button class="btn-ghost" data-reprocess="' + d.id + '">Reprocess</button></div>';
    }
    showDetail(head + body);
    wireDocToggles();
    schedulePoll();
  } catch (e) {
    if (!silent) showDetail('<div class="err-box">' + escapeHTML(e.message) + '</div>');
  }
}

// --- minimal, safe markdown renderer --------------------------------------
// Handles the deterministic MOM markdown: headings, tables, lists, blockquotes,
// bold, and paragraphs. Everything is escaped first, so no raw HTML injection.
function mdToHtml(md) {
  const lines = String(md).replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let i = 0;
  const inline = (t) => escapeHTML(t)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>");

  while (i < lines.length) {
    let line = lines[i];

    if (/^\s*$/.test(line)) { i++; continue; }

    // Headings
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { const lvl = h[1].length; html += "<h" + lvl + ">" + inline(h[2]) + "</h" + lvl + ">"; i++; continue; }

    // Blockquote
    if (/^>\s?/.test(line)) {
      let buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(inline(lines[i].replace(/^>\s?/, ""))); i++; }
      html += "<blockquote>" + buf.join("<br>") + "</blockquote>";
      continue;
    }

    // Table (header row followed by a separator row of dashes/pipes)
    if (line.indexOf("|") !== -1 && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const splitRow = (r) => r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
      const headers = splitRow(line);
      i += 2;
      let rows = [];
      while (i < lines.length && lines[i].indexOf("|") !== -1 && lines[i].trim() !== "") {
        rows.push(splitRow(lines[i])); i++;
      }
      html += "<table><thead><tr>" + headers.map((c) => "<th>" + inline(c) + "</th>").join("") + "</tr></thead><tbody>";
      rows.forEach((r) => {
        html += "<tr>" + r.map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>";
      });
      html += "</tbody></table>";
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      html += "<ul>";
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        html += "<li>" + inline(lines[i].replace(/^\s*[-*]\s+/, "")) + "</li>"; i++;
      }
      html += "</ul>";
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      html += "<ol>";
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        html += "<li>" + inline(lines[i].replace(/^\s*\d+\.\s+/, "")) + "</li>"; i++;
      }
      html += "</ol>";
      continue;
    }

    // Paragraph
    let buf = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6})\s/.test(lines[i]) &&
           !/^>\s?/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) {
      buf.push(inline(lines[i])); i++;
    }
    html += "<p>" + buf.join("<br>") + "</p>";
  }
  return html;
}

// --- Plaud sync -----------------------------------------------------------
// Only reveal the "Sync Plaud" button when the user actually has Plaud
// connected; clicking it pulls newer recordings (which become both meeting
// docs and standard conversations) and then refreshes the history list.
async function showPlaudSyncIfConnected() {
  try {
    const r = await fetch("/api/plaud/status");
    if (!r.ok) return;
    const data = await r.json().catch(() => ({}));
    if (data && data.connected) $("btn-plaud-sync").style.display = "";
  } catch (_) { /* leave the button hidden */ }
}

async function syncPlaud() {
  const btn = $("btn-plaud-sync");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Syncing…";
  try {
    const r = await fetch("/api/plaud/sync", { method: "POST" });
    if (r.status === 401) { window.location.href = "/login"; return; }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || "Plaud sync failed.");
    const parts = [`Imported ${data.imported}`];
    if (data.conversations_created) parts.push(`${data.conversations_created} conversations`);
    if (data.skipped_existing) parts.push(`${data.skipped_existing} already imported`);
    if (data.skipped_empty) parts.push(`${data.skipped_empty} empty`);
    if (data.errors) parts.push(`${data.errors} failed`);
    $("batch-status").textContent = parts.join(" · ") + ` (of ${data.total_seen} recordings).`;
    await loadHistory();
  } catch (e) {
    $("batch-status").textContent = e.message || "Plaud sync failed.";
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// --- boot -----------------------------------------------------------------
function init() {
  wireTabs();
  wireDropzone();
  $("btn-process").addEventListener("click", processPaste);
  $("btn-upload").addEventListener("click", uploadBatch);
  $("btn-refresh").addEventListener("click", loadHistory);
  $("btn-plaud-sync").addEventListener("click", syncPlaud);
  showPlaudSyncIfConnected();
  loadHistory().then(() => {
    // Deep-link from the "All Meetings" tab: /meetings?doc=<id> opens that
    // document's minutes directly.
    const doc = new URLSearchParams(window.location.search).get("doc");
    if (doc) selectDoc(/^\d+$/.test(doc) ? Number(doc) : doc);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
