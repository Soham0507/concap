/* Conversations page — list + detail with inline audio playback.
 * Reuses the shared design system (styles.css) and the same /api/conversations
 * endpoints the dashboard uses. Audio is fetched through auth.js's patched
 * fetch (which attaches the bearer token) and played from an object URL, since
 * a bare <audio src> request would not carry the Authorization header. */
const API = "";
const $ = (id) => document.getElementById(id);

let ALL = [];               // every conversation list item, unfiltered
const LIST_BY_ID = new Map(); // id -> list item (detail payload lacks visitor_name)
let selectedId = null;
let audioObjectUrl = null;  // current blob URL, revoked when we switch detail

function escapeHTML(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// created_at is naive UTC; append "Z" when no tz marker so the browser shifts
// it into the viewer's local time instead of treating it as local.
function parseServerDate(iso) {
  if (!iso) return null;
  const s = /[zZ]|[+\-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "Z";
  const d = new Date(s);
  return isNaN(d) ? null : d;
}
function fmtDate(iso) {
  const d = parseServerDate(iso);
  return d ? d.toLocaleString() : "—";
}
function fmtDateShort(iso) {
  const d = parseServerDate(iso);
  if (!d) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
    ", " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
function fmtDuration(s) {
  if (s == null) return "—";
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}m ${sec}s`;
}

// Rewrite "Speaker 0/1/2…" → an auto-detected name (analysis.speaker_names)
// when available, else "Speaker A/B/C…" by first appearance order.
function relabelTranscriptSpeakers(transcript, analysis) {
  if (!transcript || typeof transcript !== "string") return transcript || "";
  const names = (analysis && analysis.speaker_names) || {};
  const order = new Map();
  let next = 0;
  return transcript.replace(/Speaker\s+(\d+)/g, (_m, num) => {
    if (!order.has(num)) {
      order.set(num, String.fromCharCode(65 + next));
      next += 1;
    }
    const auto = names[`Speaker ${num}`];
    return (typeof auto === "string" && auto.trim()) ? auto.trim() : `Speaker ${order.get(num)}`;
  });
}

// ---- List --------------------------------------------------------------
async function loadList() {
  try {
    const r = await fetch(`${API}/api/conversations`);
    if (!r.ok) throw new Error(`List failed (${r.status})`);
    ALL = await r.json();
    LIST_BY_ID.clear();
    for (const c of ALL) LIST_BY_ID.set(c.id, c);
    applyFilters();
    applyUrlSelection({ mode: "replace" });
  } catch (e) {
    $("conv-list").innerHTML = "";
    const st = $("list-status");
    st.classList.remove("hidden");
    st.textContent = "Failed to load: " + e.message;
  }
}

function applyFilters() {
  const q = ($("q").value || "").trim().toLowerCase();
  const temp = $("filter-temp").value;
  const sort = $("filter-sort").value;

  let items = ALL.slice();
  if (q) {
    items = items.filter((c) => {
      const hay = [c.topic, c.visitor_name, c.visitor_company, c.company_name, c.staff_name]
        .filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }
  if (temp) items = items.filter((c) => c.lead_temperature === temp);

  items.sort((a, b) => {
    if (sort === "score") return (b.lead_score ?? -1) - (a.lead_score ?? -1);
    const da = parseServerDate(a.created_at)?.getTime() ?? 0;
    const db = parseServerDate(b.created_at)?.getTime() ?? 0;
    return sort === "oldest" ? da - db : db - da;
  });

  renderList(items);
}

function renderList(items) {
  const list = $("conv-list");
  const st = $("list-status");
  if (!items.length) {
    list.innerHTML = "";
    st.classList.remove("hidden");
    st.textContent = ALL.length
      ? "No conversations match your filters."
      : "No conversations yet. Capture one from the booth or upload a session.";
    return;
  }
  st.classList.add("hidden");
  list.innerHTML = items
    .map((c) => {
      const company = c.visitor_company || c.company_name || "—";
      const topic = (c.topic || "").trim();
      const title = topic || c.visitor_name || `Conversation #${c.id}`;
      const tempPill = c.lead_temperature
        ? `<span class="temp ${escapeHTML(c.lead_temperature)}">${escapeHTML(c.lead_temperature)}</span>`
        : "";
      const score = c.lead_score != null ? `<span class="muted">${c.lead_score}/100</span>` : "";
      return `
        <div class="conv-row ${c.id === selectedId ? "selected" : ""}" data-id="${c.id}">
          <div class="who">
            <strong>${escapeHTML(title)}</strong>
            <span class="sub">${escapeHTML(company)}</span>
            <div class="when">${escapeHTML(fmtDateShort(c.created_at))}</div>
          </div>
          <div class="meta">
            <span class="pill ${escapeHTML(c.status)}">${escapeHTML(c.status)}</span>
            ${tempPill}
            ${score}
            ${c.has_audio ? '<span class="audio-ic" title="Has recording">▶ rec</span>' : ""}
          </div>
        </div>`;
    })
    .join("");

  list.querySelectorAll(".conv-row").forEach((row) => {
    row.addEventListener("click", () => selectConversation(Number(row.dataset.id)));
  });
}

// Reflect the current selection in the URL so it can be copied/shared and so
// the browser back/forward buttons move between selections. `replace` is used
// for the initial deep-link load (no extra history entry); clicks push a new
// entry. id == null clears the param.
function setUrlId(id, replace) {
  const url = new URL(location.href);
  if (id == null) url.searchParams.delete("id");
  else url.searchParams.set("id", String(id));
  history[replace ? "replaceState" : "pushState"]({ convId: id ?? null }, "", url);
}

// Open a conversation and record it in browser history (push by default).
function selectConversation(id, { mode = "push" } = {}) {
  setUrlId(id, mode === "replace");
  loadDetail(id);
}

// Sync the detail pane to whatever ?id=… currently says. Used for the initial
// deep link and for back/forward navigation. Falls back gracefully: an id that
// isn't in this org's list (or isn't a number) just leaves the empty state.
function applyUrlSelection({ mode = "replace" } = {}) {
  const raw = new URLSearchParams(location.search).get("id");
  const id = raw != null && /^\d+$/.test(raw) ? Number(raw) : null;
  if (id != null && LIST_BY_ID.has(id)) {
    if (id !== selectedId) loadDetail(id);
  } else {
    if (selectedId != null) clearDetail();
    // Drop an unusable id from the URL so it doesn't linger when shared again.
    if (raw != null && mode === "replace") setUrlId(null, true);
  }
}

// ---- Detail ------------------------------------------------------------
async function loadDetail(id) {
  selectedId = id;
  // Reflect selection in the list without a full re-render.
  document.querySelectorAll(".conv-row").forEach((r) => {
    r.classList.toggle("selected", Number(r.dataset.id) === id);
  });
  releaseAudio();
  $("detail-empty").classList.add("hidden");
  const body = $("detail-body");
  body.classList.remove("hidden");
  body.innerHTML = "<div class='muted'>Loading…</div>";
  try {
    const r = await fetch(`${API}/api/conversations/${id}`);
    if (!r.ok) throw new Error(`Load failed (${r.status})`);
    const c = await r.json();
    renderDetail(c);
  } catch (e) {
    body.innerHTML = `<div class='alert error'>${escapeHTML(e.message)}</div>`;
  }
  // On narrow screens the detail sits below the list — bring it into view.
  if (window.matchMedia("(max-width: 980px)").matches) {
    $("detail-card").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// Return the detail pane to its empty state (used when back/forward lands on a
// history entry without a selected conversation).
function clearDetail() {
  selectedId = null;
  releaseAudio();
  document.querySelectorAll(".conv-row").forEach((r) => r.classList.remove("selected"));
  const body = $("detail-body");
  body.classList.add("hidden");
  body.innerHTML = "";
  $("detail-empty").classList.remove("hidden");
}

function releaseAudio() {
  if (audioObjectUrl) {
    URL.revokeObjectURL(audioObjectUrl);
    audioObjectUrl = null;
  }
}

function renderDetail(c) {
  const a = c.analysis || {};
  const li = LIST_BY_ID.get(c.id) || {};
  const visitorName = (li.visitor_name || "").trim();
  const topic = (c.topic || a.topic || "").trim();
  const title = topic || visitorName || `Conversation #${c.id}`;

  const tagList = (arr) =>
    (arr || []).length
      ? `<ul class="tag-list">${arr.map((x) => `<li>${escapeHTML(x)}</li>`).join("")}</ul>`
      : '<span class="muted">—</span>';

  const errorBlock = c.status === "error"
    ? `<div class="alert error">Processing error: ${escapeHTML(c.error_message || "unknown")}</div>`
    : "";
  const pendingBlock =
    ["created", "uploaded", "queued", "transcribing", "analyzing"].includes(c.status)
      ? `<div class="alert info">Processing in progress (${escapeHTML(c.status)})…</div>`
      : "";

  // Linked contact + company chips.
  const contactChip = `
    <a class="linked-chip" href="/contacts?contact_id=${c.visitor_id}">
      <span class="lc-ic">◰</span>
      <span><span class="lc-label">Contact</span><span class="lc-value">${escapeHTML(visitorName || "View contact")}</span></span>
    </a>`;
  let companyChip = "";
  if (c.company_id) {
    companyChip = `
      <a class="linked-chip" href="/companies?company_id=${c.company_id}">
        <span class="lc-ic">▦</span>
        <span><span class="lc-label">Company</span><span class="lc-value">${escapeHTML(c.company_name || "View company")}</span></span>
      </a>`;
  } else if (c.suggested_company) {
    companyChip = `
      <span class="linked-chip" style="cursor:default;">
        <span class="lc-ic">▦</span>
        <span><span class="lc-label">Suggested company</span><span class="lc-value">${escapeHTML(c.suggested_company)}</span></span>
      </span>`;
  }

  const hasAudio = Boolean(c.audio_filename);
  const audioBlock = `
    <div class="audio-block">
      <div class="audio-title"><span>♪</span> Recording</div>
      <div id="audio-slot">${hasAudio ? "<div class='audio-none'>Loading audio…</div>" : "<div class='audio-none'>No recording available for this conversation.</div>"}</div>
    </div>`;

  $("detail-body").innerHTML = `
    ${errorBlock}
    ${pendingBlock}
    <div class="detail-head">
      <h2>${escapeHTML(title)}</h2>
      <span class="pill ${escapeHTML(c.status)}">${escapeHTML(c.status)}</span>
      ${c.lead_temperature ? `<span class="temp ${escapeHTML(c.lead_temperature)}">${escapeHTML(c.lead_temperature)}</span>` : ""}
      ${c.lead_score != null ? `<span><strong>${c.lead_score}</strong>/100</span>` : ""}
      <button type="button" class="secondary" id="hs-sync-btn" style="margin-left:auto;">${c.hubspot_synced_at ? "Re-sync to HubSpot" : "Sync to HubSpot"}</button>
      <button type="button" class="btn-delete-conv" id="delete-conv-btn" title="Delete this conversation">🗑 Delete</button>
    </div>
    <div class="muted" style="margin-bottom:6px;">${escapeHTML(fmtDuration(c.duration_seconds))} · ${escapeHTML(fmtDate(c.created_at))}${c.staff_name ? " · " + escapeHTML(c.staff_name) : ""}</div>
    <div id="hs-sync-status" class="muted" style="margin-bottom:16px;">${renderHubspotStatus(c)}</div>

    <div class="linked-row">${contactChip}${companyChip}<button type="button" class="btn-change-contact" id="change-contact-btn">↔ Change contact</button></div>

    ${audioBlock}

    ${a.summary ? `<h3>Summary</h3><p style="margin-bottom:18px;">${escapeHTML(a.summary)}</p>` : ""}

    ${a.next_action && String(a.next_action).trim() && String(a.next_action).trim() !== "—"
      ? `<div class="next-step"><span class="ns-label">Recommended next step</span><span>${escapeHTML(a.next_action)}</span></div>`
      : ""}

    ${(a.decisions || []).length
      ? `<h3>Decisions</h3><ul class="action-list decisions">${a.decisions.map((x) => `<li>${escapeHTML(x)}</li>`).join("")}</ul>`
      : ""}

    ${(a.action_items || []).length
      ? `<h3>Follow-ups</h3><ul class="action-list followups">${a.action_items.map((x) => `<li>${escapeHTML(x)}</li>`).join("")}</ul>`
      : ""}

    <h3>Lead profile</h3>
    <dl class="detail-grid" style="margin-bottom:18px;">
      <dt>Intent</dt><dd>${escapeHTML(a.intent || "—")}</dd>
      <dt>Budget</dt><dd>${escapeHTML(a.budget_range || "—")}</dd>
      <dt>Urgency</dt><dd>${escapeHTML(a.urgency || "—")}</dd>
      <dt>Timeline</dt><dd>${escapeHTML(a.timeline || "—")}</dd>
      <dt>Buying role</dt><dd>${escapeHTML(a.buying_role || "—")}</dd>
      <dt>Sentiment</dt><dd>${escapeHTML(a.sentiment || "—")}</dd>
      <dt>Products</dt><dd>${tagList(a.products_discussed)}</dd>
      <dt>Pain points</dt><dd>${tagList(a.pain_points)}</dd>
      <dt>Competitors</dt><dd>${tagList(a.competitors_mentioned)}</dd>
    </dl>

    ${(a.key_quotes || []).length
      ? `<h3>Key quotes</h3><ul style="margin-bottom:18px;">${a.key_quotes.map((q) => `<li>"${escapeHTML(q)}"</li>`).join("")}</ul>`
      : ""}

    ${c.transcript
      ? `<h3>Transcript ${c.transcript_language ? `(${escapeHTML(c.transcript_language)})` : ""}</h3>
         <div class="transcript-box">${escapeHTML(relabelTranscriptSpeakers(c.transcript, c.analysis))}</div>`
      : '<h3>Transcript</h3><div class="muted">Not available yet.</div>'}
  `;

  if (hasAudio) loadAudioInto(c.id);

  const cb = document.getElementById("change-contact-btn");
  if (cb) cb.addEventListener("click", openContactPicker);

  const del = document.getElementById("delete-conv-btn");
  if (del) del.addEventListener("click", () => deleteConversation(c.id, title));

  const hs = document.getElementById("hs-sync-btn");
  if (hs) hs.addEventListener("click", () => syncToHubspot(c, hs));
}

// Render a one-line HubSpot mirror status for the conversation detail. Prefers
// clickable record links (when URLs are present), else a plain "synced" note.
function renderHubspotStatus(c) {
  if (c.hubspot_sync_error) {
    return `<span style="color: var(--danger, #ef4444);">HubSpot sync failed: ${escapeHTML(c.hubspot_sync_error)}</span>`;
  }
  if (!c.hubspot_synced_at && !c.hubspot_contact_id) return "";
  const urls = c._hubspot_urls || {};
  const when = c.hubspot_synced_at ? new Date(c.hubspot_synced_at).toLocaleString() : "";
  const parts = [];
  if (c.hubspot_contact_id) {
    parts.push(urls.contact_url
      ? `<a href="${urls.contact_url}" target="_blank" rel="noopener">Contact ↗</a>`
      : "Contact");
  }
  if (c.hubspot_company_id) {
    parts.push(urls.company_url
      ? `<a href="${urls.company_url}" target="_blank" rel="noopener">Company ↗</a>`
      : "Company");
  }
  if (c.hubspot_deal_id) {
    parts.push(urls.deal_url
      ? `<a href="${urls.deal_url}" target="_blank" rel="noopener">Deal ↗</a>`
      : "Deal");
  }
  const links = parts.length ? ` · ${parts.join(" · ")}` : "";
  return `Synced to HubSpot${when ? ` ${escapeHTML(when)}` : ""}${links}`;
}

// Push (or re-push) this conversation to HubSpot, then refresh the status line.
async function syncToHubspot(c, btn) {
  const status = document.getElementById("hs-sync-status");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Syncing…";
  if (status) status.innerHTML = '<span class="muted">Syncing to HubSpot…</span>';
  try {
    const r = await fetch(`${API}/api/conversations/${c.id}/hubspot-sync`, { method: "POST" });
    if (r.status === 401) {
      window.location.href = "/login";
      return;
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `Sync failed (${r.status})`);
    Object.assign(c, {
      hubspot_contact_id: data.contact_id || c.hubspot_contact_id,
      hubspot_company_id: data.company_id || c.hubspot_company_id,
      hubspot_note_id: data.note_id || c.hubspot_note_id,
      hubspot_deal_id: data.deal_id || c.hubspot_deal_id,
      hubspot_synced_at: data.synced_at || new Date().toISOString(),
      hubspot_sync_error: null,
      _hubspot_urls: {
        contact_url: data.contact_url,
        company_url: data.company_url,
        deal_url: data.deal_url,
      },
    });
    btn.textContent = "Re-sync to HubSpot";
    if (status) status.innerHTML = renderHubspotStatus(c);
  } catch (e) {
    c.hubspot_sync_error = e.message;
    if (status) status.innerHTML = renderHubspotStatus(c);
    btn.textContent = original;
  } finally {
    btn.disabled = false;
  }
}

// Permanently delete a conversation after confirmation, then drop it from the
// list and clear the detail pane.
async function deleteConversation(id, title) {
  const label = (title || `Conversation #${id}`).trim();
  if (!confirm(`Delete "${label}"?\n\nThis permanently removes the conversation, its analysis, and any recording. This can't be undone.`)) {
    return;
  }
  const btn = document.getElementById("delete-conv-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Deleting…"; }
  try {
    const r = await fetch(`${API}/api/conversations/${id}`, { method: "DELETE" });
    if (!r.ok && r.status !== 204) throw new Error(`Delete failed (${r.status})`);
    ALL = ALL.filter((c) => c.id !== id);
    LIST_BY_ID.delete(id);
    clearDetail();
    setUrlId(null, true);
    applyFilters();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = "🗑 Delete"; }
    alert(`Couldn't delete: ${e.message}`);
  }
}

// ---- Contact relink picker ---------------------------------------------
let pickerContacts = [];      // /api/visitors snapshot for the open picker
let pickerCurrentVisitorId = null; // the conversation's current contact

function cmEl(id) { return document.getElementById(id); }

function openPickerModal() { cmEl("contact-modal").classList.add("open"); }
function closePickerModal() {
  cmEl("contact-modal").classList.remove("open");
  cmEl("cm-search").value = "";
  cmEl("cm-new-name").value = "";
  cmEl("cm-new-company").value = "";
}

// Open the picker for the currently selected conversation. Loads the org's
// contacts on demand (this page doesn't otherwise need them).
async function openContactPicker() {
  if (selectedId == null) return;
  pickerCurrentVisitorId = LIST_BY_ID.get(selectedId)?.visitor_id ?? null;
  openPickerModal();
  const listEl = cmEl("cm-list");
  listEl.innerHTML = "<div class='cm-empty'>Loading contacts…</div>";
  try {
    const r = await fetch(`${API}/api/visitors`);
    if (!r.ok) throw new Error(`status ${r.status}`);
    pickerContacts = await r.json();
    renderPickerList();
  } catch (e) {
    listEl.innerHTML = `<div class='cm-empty'>Couldn't load contacts (${escapeHTML(e.message)}).</div>`;
  }
}

function renderPickerList() {
  const q = (cmEl("cm-search").value || "").trim().toLowerCase();
  const listEl = cmEl("cm-list");
  let items = pickerContacts.slice();
  if (q) {
    items = items.filter((c) => {
      const hay = [c.name, c.company, c.email, c.phone, c.designation]
        .filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }
  items = items.slice(0, 100);
  if (!items.length) {
    listEl.innerHTML = "<div class='cm-empty'>No contacts match. Create a new one below.</div>";
    return;
  }
  listEl.innerHTML = items.map((c) => {
    const isCurrent = c.id === pickerCurrentVisitorId;
    const sub = [c.company, c.email].filter(Boolean).join(" · ");
    return `<button type="button" class="cm-item ${isCurrent ? "current" : ""}" data-id="${c.id}" ${isCurrent ? "disabled" : ""}>
      <span class="nm">${escapeHTML(c.name || "Unnamed")}${isCurrent ? " (current)" : ""}</span>
      ${sub ? `<span class="sub">${escapeHTML(sub)}</span>` : ""}
    </button>`;
  }).join("");
  listEl.querySelectorAll(".cm-item").forEach((el) => {
    el.addEventListener("click", () => {
      const id = Number(el.dataset.id);
      if (id !== pickerCurrentVisitorId) relinkContact(id);
    });
  });
}

// PATCH the conversation onto an existing in-org contact, then refresh.
async function relinkContact(visitorId) {
  const convId = selectedId;
  try {
    const r = await fetch(`${API}/api/conversations/${convId}/contact`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitor_id: visitorId }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `Relink failed (${r.status})`);
    closePickerModal();
    await loadList();        // refresh the list so the row's name/company update
    await loadDetail(convId); // re-render the detail with the new contact
  } catch (e) {
    cmEl("cm-list").innerHTML = `<div class='cm-empty'>${escapeHTML(e.message)}</div>`;
  }
}

// Create a brand-new contact (reusing the validated /api/visitors path) and
// link it to the conversation in one action.
async function createAndLinkContact() {
  const convId = selectedId;
  const name = cmEl("cm-new-name").value.trim();
  const company = cmEl("cm-new-company").value.trim();
  if (!name) { cmEl("cm-new-name").focus(); return; }
  const btn = cmEl("cm-create");
  btn.disabled = true;
  try {
    const cr = await fetch(`${API}/api/visitors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, company: company || null, source: "manual" }),
    });
    const created = await cr.json().catch(() => ({}));
    if (!cr.ok) throw new Error(created.detail || `Create failed (${cr.status})`);
    await relinkContact(created.id);
  } catch (e) {
    cmEl("cm-list").innerHTML = `<div class='cm-empty'>${escapeHTML(e.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

// Fetch the audio through the patched (authorized) fetch, then play it from a
// blob URL. Range-based seeking still works because the whole clip lives in
// memory once fetched. Falls back to a clear message on failure.
async function loadAudioInto(convId) {
  const slot = $("audio-slot");
  try {
    const r = await fetch(`${API}/api/conversations/${convId}/audio`);
    if (!r.ok) throw new Error(`status ${r.status}`);
    const blob = await r.blob();
    if (selectedId !== convId) return; // user moved on while we were loading
    releaseAudio();
    audioObjectUrl = URL.createObjectURL(blob);
    if (slot) {
      slot.innerHTML = "";
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.preload = "metadata";
      audio.src = audioObjectUrl;
      slot.appendChild(audio);
    }
  } catch (e) {
    if (slot) slot.innerHTML = `<div class="audio-none">Couldn't load the recording (${escapeHTML(e.message)}).</div>`;
  }
}

// ---- Init --------------------------------------------------------------
function init() {
  $("q").addEventListener("input", applyFilters);
  $("filter-temp").addEventListener("change", applyFilters);
  $("filter-sort").addEventListener("change", applyFilters);
  // Back/forward between selections — re-sync the detail to the URL.
  window.addEventListener("popstate", () => applyUrlSelection({ mode: "none" }));
  // Contact relink picker.
  $("cm-close").addEventListener("click", closePickerModal);
  $("cm-search").addEventListener("input", renderPickerList);
  $("cm-create").addEventListener("click", createAndLinkContact);
  $("contact-modal").addEventListener("click", (e) => {
    if (e.target === $("contact-modal")) closePickerModal();
  });
  loadList();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
