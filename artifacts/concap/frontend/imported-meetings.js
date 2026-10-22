/* Imported Meetings page.
 *
 * A dedicated tab (separate from Meeting Intelligence). Three intake modes:
 *   1. Paste / Upload — chat logs & transcripts parsed by conversation_parsers.
 *   2. Providers — connect Zoom / Google Meet / Microsoft Teams via per-org
 *      OAuth and pull recent cloud-recording transcripts.
 *   3. Speakers — the cross-meeting voiceprint registry.
 * The detail pane shows a meeting's speakers (with talk-time + match status,
 * confirmable into the registry) and its full diarized transcript.
 *
 * All API calls go through auth.js's patched fetch (bearer attached).
 */
const API = "/api/imported-meetings";
const $ = (id) => document.getElementById(id);

let MEETINGS = [];
let CREATED = [];
let ANY_PROVIDER_CONNECTED = false;
let selectedId = null;
let selectedCreatedId = null;
let pickedFile = null;
let detailSeg = "speakers";
let selectedProvider = "zoom";
let PROVIDERS_STATUS = [];

function escapeHTML(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
// Only trust http(s) URLs from provider APIs — never javascript:/data: schemes.
function safeUrl(u) {
  try {
    const p = new URL(String(u || ""), window.location.origin);
    return (p.protocol === "https:" || p.protocol === "http:") ? p.href : "";
  } catch (e) {
    return "";
  }
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
function fmtDuration(ms) {
  const sec = Math.round((ms || 0) / 1000);
  if (sec < 60) return sec + "s";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + "m" + (s ? " " + s + "s" : "");
}
// "Jun 13, 2026"
function fmtDateLong(iso) {
  const d = parseServerDate(iso);
  if (!d) return "Date to be set";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
// "8:10 PM - 9:10 PM GMT+5:30" (end carries the timezone label)
function fmtTimeRange(iso, durMin) {
  const d = parseServerDate(iso);
  if (!d) return "Time to be set";
  const opt = { hour: "numeric", minute: "2-digit" };
  const start = d.toLocaleTimeString(undefined, opt);
  if (!durMin) {
    return new Intl.DateTimeFormat(undefined, { ...opt, timeZoneName: "short" }).format(d);
  }
  const end = new Date(d.getTime() + durMin * 60000);
  const endStr = new Intl.DateTimeFormat(undefined, { ...opt, timeZoneName: "short" }).format(end);
  return `${start} - ${endStr}`;
}
// Value for an <input type="datetime-local"> in the viewer's local time.
function toLocalInput(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// Inline SVG icons (14px, stroke = currentColor) for the scheduled-meeting cards.
const SC_ICONS = {
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  join: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  paste: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  id: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M15 8h4M15 12h4M7 16h10"/></svg>',
};
const STATUS_PILL = { Scheduled: "scheduled", Ongoing: "ongoing", Completed: "completed" };
const PROVIDER_LABELS = {
  manual: "Text", plain: "Text", slack: "Slack", discord: "Discord",
  email: "Email", srt: "Subtitles", zoom: "Zoom",
  google_meet: "Google Meet", ms_teams: "MS Teams",
};

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

// --- primary tab + provider sub-tab switching -----------------------------
function switchPrimary(name) {
  document.querySelectorAll(".ptab").forEach((t) =>
    t.classList.toggle("active", t.dataset.ptab === name));
  document.querySelectorAll(".primary-pane").forEach((p) =>
    p.classList.toggle("active", p.dataset.ppane === name));
  if (name === "speakers") loadSpeakers();
  if (name === "meetings") { loadProviders(); loadCreatedMeetings(); }
}
function wirePrimaryTabs() {
  document.querySelectorAll(".ptab").forEach((tab) => {
    tab.addEventListener("click", () => switchPrimary(tab.dataset.ptab));
  });
}
function wireProviderTabs() {
  document.querySelectorAll(".prov-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      selectedProvider = tab.dataset.prov;
      document.querySelectorAll(".prov-tab").forEach((t) =>
        t.classList.toggle("active", t === tab));
      renderProviderPanel();
      renderCreatedList();
    });
  });
}

// --- meeting list ---------------------------------------------------------
async function loadMeetings() {
  try {
    const data = await api("");
    MEETINGS = data.meetings || [];
    renderList();
  } catch (e) {
    $("list-status").textContent = e.message;
  }
}

function renderList() {
  const wrap = $("meeting-list");
  const status = $("list-status");
  const countEl = $("imported-count");
  if (countEl) countEl.textContent = MEETINGS.length + " total";
  if (!MEETINGS.length) {
    wrap.innerHTML = "";
    status.textContent = "No imported meetings yet.";
    status.classList.remove("hidden");
    return;
  }
  status.classList.add("hidden");
  wrap.innerHTML = MEETINGS.map((m) => {
    const label = PROVIDER_LABELS[m.provider] || m.provider;
    const when = m.started_at || m.created_at;
    const matched = m.matched_count ? ` · ${m.matched_count} known` : "";
    return `<div class="batch-row ${m.id === selectedId ? "selected" : ""}" data-id="${m.id}">
      <div class="br-top">
        <span class="br-label">${escapeHTML(m.title)}</span>
        <span class="br-when">${fmtDate(when)}</span>
      </div>
      <div class="br-meta">
        <span class="pill ${escapeHTML(m.provider)}">${escapeHTML(label)}</span>
        &nbsp;${m.speaker_count} speaker${m.speaker_count === 1 ? "" : "s"}${matched} · ${m.utterance_count} lines
      </div>
    </div>`;
  }).join("");
  wrap.querySelectorAll(".batch-row").forEach((row) => {
    row.addEventListener("click", () => openMeeting(Number(row.dataset.id)));
  });
}

// --- created (scheduled) meetings ----------------------------------------
// Meetings scheduled FROM this app. Persisted server-side, but only returned
// while their provider stays connected — disconnecting hides them.
async function loadCreatedMeetings() {
  try {
    const data = await api("/providers/created-meetings");
    CREATED = data.meetings || [];
  } catch (e) {
    CREATED = [];
  }
  renderCreatedList();
}

function renderCreatedList() {
  const card = $("created-card");
  const wrap = $("created-list");
  if (!card || !wrap) return;
  // If a previously-selected scheduled meeting no longer exists at all (e.g.
  // its provider was disconnected), reset the right-panel viewer.
  if (selectedCreatedId != null && !CREATED.some((m) => m.id === selectedCreatedId)) {
    selectedCreatedId = null;
    if (selectedId == null) {
      $("detail-body").classList.add("hidden");
      $("detail-empty").classList.remove("hidden");
    }
  }
  // Only show scheduled meetings for the provider sub-tab currently in focus.
  const list = CREATED.filter((m) => m.provider === selectedProvider);
  const provConnected = PROVIDERS_STATUS.some(
    (p) => p.provider === selectedProvider && p.connected);
  if (!list.length) {
    // Show a friendly empty state once this provider is connected (so the user
    // knows where their scheduled meetings will appear); otherwise hide the
    // whole section since they can't create one yet.
    if (provConnected) {
      card.classList.remove("hidden");
      wrap.innerHTML = `<div class="sc-empty">
        <div class="sc-empty-ic">${SC_ICONS.cal}</div>
        <div class="sc-empty-title">No scheduled meetings yet</div>
        <div class="sc-empty-sub">Use <strong>New meeting</strong> on the connected provider to schedule one — it'll show up here.</div>
      </div>`;
    } else {
      card.classList.add("hidden");
      wrap.innerHTML = "";
    }
    return;
  }
  card.classList.remove("hidden");
  wrap.innerHTML = list.map((m) => {
    const when = m.start || m.created_at;
    const count = (typeof m.attendee_count === "number") ? m.attendee_count : (m.attendees || []).filter(Boolean).length;
    const attRow = count
      ? `<div class="sc-row"><span class="sc-ic">${SC_ICONS.people}</span><span>${count} ${count === 1 ? "participant" : "participants"}</span></div>`
      : "";
    const orgRow = m.organizer_name
      ? `<div class="sc-row"><span class="sc-ic">${SC_ICONS.user}</span><span>${escapeHTML(m.organizer_name)}</span></div>`
      : "";
    const idRow = m.meeting_id
      ? `<div class="sc-row"><span class="sc-ic">${SC_ICONS.id}</span><span>ID ${escapeHTML(m.meeting_id)}${m.passcode ? " · Passcode " + escapeHTML(m.passcode) : ""}</span></div>`
      : "";
    const status = m.status || "Scheduled";
    const pillCls = STATUS_PILL[status] || "scheduled";
    const link = safeUrl(m.join_url || m.html_link || "");
    const canJoin = m.can_join !== false;
    const joinBtn = (link && canJoin)
      ? `<a class="sc-btn join" href="${escapeHTML(link)}" target="_blank" rel="noopener"><span class="sc-bic">${SC_ICONS.join}</span>Join</a>`
      : `<button class="sc-btn" type="button" disabled title="${link ? "Available closer to the start time" : "No join link"}"><span class="sc-bic">${SC_ICONS.join}</span>Join</button>`;
    return `<div class="sched-card ${m.id === selectedCreatedId ? "selected" : ""}" data-cid="${m.id}">
      <div class="sc-head">
        <span class="sc-title">${escapeHTML(m.title)}</span>
        <span class="pill ${pillCls}">${escapeHTML(status)}</span>
      </div>
      <div class="sc-meta">
        <div class="sc-row"><span class="sc-ic">${SC_ICONS.cal}</span><span>${escapeHTML(fmtDateLong(when))}</span></div>
        <div class="sc-row"><span class="sc-ic">${SC_ICONS.clock}</span><span>${escapeHTML(fmtTimeRange(m.start, m.duration_minutes))}</span></div>
        ${attRow}
        ${orgRow}
        ${idRow}
      </div>
      <div class="sc-actions">
        ${joinBtn}
        <button class="sc-btn" type="button" data-act="copy"><span class="sc-bic">${SC_ICONS.copy}</span>Copy Link</button>
        <button class="sc-btn" type="button" data-act="invite"><span class="sc-bic">${SC_ICONS.mail}</span>Invite</button>
        <button class="sc-btn" type="button" data-act="participants"><span class="sc-bic">${SC_ICONS.users}</span>Participants${count ? " (" + count + ")" : ""}</button>
        <button class="sc-btn" type="button" data-act="fetch"><span class="sc-bic">${SC_ICONS.doc}</span>Fetch Transcript</button>
        <button class="sc-btn" type="button" data-act="paste"><span class="sc-bic">${SC_ICONS.paste}</span>Paste</button>
        <button class="sc-btn" type="button" data-act="edit"><span class="sc-bic">${SC_ICONS.edit}</span>Edit</button>
        <button class="sc-btn danger" type="button" data-act="delete"><span class="sc-bic">${SC_ICONS.trash}</span>Delete</button>
      </div>
    </div>`;
  }).join("");
  wrap.querySelectorAll(".sched-card").forEach((cardEl) => {
    const id = Number(cardEl.dataset.cid);
    cardEl.querySelectorAll(".sc-btn").forEach((b) => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (b.dataset.act) handleCreatedAction(b.dataset.act, id, b);
      });
    });
    cardEl.addEventListener("click", () => openCreatedMeeting(id));
  });
}

// Copy text using the Clipboard API, falling back to execCommand for
// insecure contexts (http / older browsers) where navigator.clipboard is absent.
function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast("Link copied.")).catch(() => fallbackCopy(text));
    return;
  }
  fallbackCopy(text);
}
function fallbackCopy(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    toast(ok ? "Link copied." : "Couldn't copy link.");
  } catch {
    toast("Couldn't copy link.");
  }
}

// Dispatch a scheduled-card action button (Copy / Fetch / Paste / Edit / Delete).
function handleCreatedAction(act, id, btn) {
  const m = CREATED.find((x) => x.id === id);
  if (!m) return;
  if (act === "copy") {
    const link = safeUrl(m.join_url || m.html_link || "");
    if (!link) { toast("No join link to copy."); return; }
    copyToClipboard(link);
  } else if (act === "invite") {
    openInviteModal(m);
  } else if (act === "participants") {
    openParticipantsModal(m);
  } else if (act === "fetch") {
    fetchTranscriptForMeeting(m, btn);
  } else if (act === "paste") {
    pasteForMeeting(m);
  } else if (act === "edit") {
    openEditMeetingModal(m);
  } else if (act === "delete") {
    deleteCreatedMeeting(m);
  }
}

// Invite participants — collect emails, send invitation emails via Gmail.
function openInviteModal(m) {
  const brand = PROVIDER_BRAND[m.provider] || PROVIDER_BRAND.google_meet;
  const modal = openModal(`
    <div class="modal-head">
      <div class="prov-logo">${SC_ICONS.mail}</div>
      <h3>Invite participants</h3>
      <button class="modal-x" id="iv-x" type="button">×</button>
    </div>
    <div class="modal-body">
      <div class="field">
        <label for="iv-emails">Emails (comma or space separated)</label>
        <input id="iv-emails" type="text" placeholder="alex@acme.com, jordan@acme.com" autofocus />
      </div>
      <div class="muted" style="font-size:12px;">${escapeHTML(INVITE_HINT[m.provider] || INVITE_HINT.google_meet)}</div>
      <div id="iv-out"></div>
    </div>
    <div class="modal-foot">
      <button class="btn-ghost" id="iv-cancel" type="button" style="padding:8px 14px;">Cancel</button>
      <button class="pull-btn" id="iv-send" type="button">Send invitations</button>
    </div>`, brand);
  modal.querySelector("#iv-x").addEventListener("click", closeModal);
  modal.querySelector("#iv-cancel").addEventListener("click", closeModal);
  modal.querySelector("#iv-send").addEventListener("click", () => submitInvite(modal, m));
}

async function submitInvite(modal, m) {
  const btn = modal.querySelector("#iv-send");
  const out = modal.querySelector("#iv-out");
  const emails = modal.querySelector("#iv-emails").value
    .split(/[\s,;]+/).map((s) => s.trim()).filter((s) => s.includes("@"));
  if (!emails.length) {
    out.innerHTML = `<div class="err-box" style="margin-top:8px;">Add at least one valid email address.</div>`;
    return;
  }
  btn.disabled = true;
  btn.classList.add("busy");
  btn.innerHTML = `<span class="pull-ic">⟳</span> Sending…`;
  try {
    const r = await api("/providers/created-meetings/" + m.id + "/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails }),
    });
    closeModal();
    const n = (r.invite && r.invite.sent) || emails.length;
    toast(`✓ ${n} invitation${n === 1 ? "" : "s"} sent.`);
    await loadCreatedMeetings();
  } catch (e) {
    out.innerHTML = `<div class="err-box" style="margin-top:8px;">${escapeHTML(e.message)}</div>`;
    btn.disabled = false;
    btn.classList.remove("busy");
    btn.innerHTML = "Send invitations";
  }
}

// View Participants — list invited participants with status + resend.
function openParticipantsModal(m) {
  const brand = PROVIDER_BRAND[m.provider] || PROVIDER_BRAND.google_meet;
  const modal = openModal(`
    <div class="modal-head">
      <div class="prov-logo">${SC_ICONS.users}</div>
      <h3>Participants</h3>
      <button class="modal-x" id="pp-x" type="button">×</button>
    </div>
    <div class="modal-body" id="pp-body"></div>
    <div class="modal-foot">
      <button class="btn-ghost" id="pp-close" type="button" style="padding:8px 14px;">Close</button>
      <button class="pull-btn" id="pp-resend-all" type="button">Resend all</button>
    </div>`, brand);
  modal.querySelector("#pp-x").addEventListener("click", closeModal);
  modal.querySelector("#pp-close").addEventListener("click", closeModal);
  renderParticipants(modal, m);
  modal.querySelector("#pp-resend-all").addEventListener("click", () => resendInvites(modal, m, null));
}

function renderParticipants(modal, m) {
  const body = modal.querySelector("#pp-body");
  const inv = (m.invitations || []);
  const resendAll = modal.querySelector("#pp-resend-all");
  if (!inv.length) {
    body.innerHTML = `<div class="muted" style="font-size:13px;">No one has been invited yet. Use <strong>Invite</strong> to add participants.</div>`;
    if (resendAll) resendAll.style.display = "none";
    return;
  }
  if (resendAll) resendAll.style.display = "";
  body.innerHTML = `<div class="pp-list">` + inv.map((p) => {
    const sent = p.last_sent_at ? fmtDate(p.last_sent_at) : (p.invited_at ? fmtDate(p.invited_at) : "");
    return `<div class="pp-row">
      <div class="pp-info">
        <div class="pp-email">${escapeHTML(p.email)}</div>
        <div class="pp-sub"><span class="pp-badge">Invited</span>${sent ? " · " + escapeHTML(sent) : ""}</div>
      </div>
      <button class="mini-btn" type="button" data-resend="${escapeHTML(p.email)}">Resend</button>
    </div>`;
  }).join("") + `</div>`;
  body.querySelectorAll("[data-resend]").forEach((b) => {
    b.addEventListener("click", () => resendInvites(modal, m, [b.dataset.resend], b));
  });
}

async function resendInvites(modal, m, emails, btn) {
  const target = btn || modal.querySelector("#pp-resend-all");
  const orig = target ? target.innerHTML : "";
  if (target) { target.disabled = true; target.innerHTML = "Sending…"; }
  try {
    const r = await api("/providers/created-meetings/" + m.id + "/resend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails: emails || null }),
    });
    const n = (r.resend && r.resend.sent) || (emails ? emails.length : (m.invitations || []).length);
    toast(`✓ ${n} invitation${n === 1 ? "" : "s"} re-sent.`);
    await loadCreatedMeetings();
    const updated = CREATED.find((x) => x.id === m.id);
    if (updated) renderParticipants(modal, updated);
  } catch (e) {
    toast(e.message);
    if (target) { target.disabled = false; target.innerHTML = orig; }
  }
}

// Pull recent recording transcripts for this meeting's provider (reuses sync).
async function fetchTranscriptForMeeting(m, btn) {
  btn.disabled = true;
  const orig = btn.innerHTML;
  btn.innerHTML = `<span class="sc-bic">${SC_ICONS.doc}</span>Fetching…`;
  try {
    const r = await api("/providers/" + m.provider + "/sync", { method: "POST" });
    if (r.imported) toast(`✓ ${r.imported} transcript${r.imported === 1 ? "" : "s"} pulled in.`);
    else if (r.fetched) toast(`Up to date — ${r.skipped} already imported.`);
    else toast("No recordings with transcripts found yet.");
    await loadMeetings();
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

// Jump to the Paste intake with this meeting's title prefilled.
function pasteForMeeting(m) {
  switchPrimary("paste");
  const titleEl = $("m-title");
  if (titleEl) titleEl.value = m.title || "";
  const ta = $("m-text");
  if (ta) { ta.focus(); ta.scrollIntoView({ behavior: "smooth", block: "center" }); }
  toast("Paste the transcript, then Import.");
}

async function deleteCreatedMeeting(m) {
  if (!window.confirm(`Delete "${m.title}"? This removes it from your scheduled list.`)) return;
  try {
    await api("/providers/created-meetings/" + m.id, { method: "DELETE" });
    toast("Meeting deleted.");
    if (selectedCreatedId === m.id) {
      selectedCreatedId = null;
      $("detail-body").classList.add("hidden");
      $("detail-empty").classList.remove("hidden");
    }
    await loadCreatedMeetings();
  } catch (e) {
    toast(e.message);
  }
}

function openEditMeetingModal(m) {
  const provider = m.provider;
  const brand = PROVIDER_BRAND[provider] || PROVIDER_BRAND.google_meet;
  const label = PROVIDER_LABELS[provider] || provider;
  const d = parseServerDate(m.start);
  const whenVal = d ? toLocalInput(d) : "";
  const dur = m.duration_minutes || 30;
  const durOpts = [15, 30, 45, 60, 90]
    .map((v) => `<option value="${v}" ${v === dur ? "selected" : ""}>${v >= 60 ? (v / 60) + (v === 60 ? " hour" : " hours") : v + " min"}</option>`)
    .join("");
  const attStr = (m.attendees || []).join(", ");
  const attField = `
      <div class="field">
        <label for="em-att">Invitees (comma or space separated emails)</label>
        <input id="em-att" type="text" value="${escapeHTML(attStr)}" placeholder="alex@acme.com, jordan@acme.com" />
        <div class="muted" style="font-size:11px; margin-top:4px;">${escapeHTML(provider === "zoom" ? "New invitees are emailed an invitation from this app. Changes to the time/title re-notify everyone already invited." : "New invitees and any time/title changes are sent to everyone automatically by " + (provider === "ms_teams" ? "Outlook" : "Google Calendar") + ".")}</div>
      </div>`;
  const modal = openModal(`
    <div class="modal-head">
      <div class="prov-logo">${escapeHTML(brand.mark)}</div>
      <h3>Edit ${escapeHTML(label)}</h3>
      <button class="modal-x" id="em-x" type="button">×</button>
    </div>
    <div class="modal-body">
      <div class="field">
        <label for="em-title">Title</label>
        <input id="em-title" type="text" value="${escapeHTML(m.title || "")}" />
      </div>
      <div class="grid-2">
        <div class="field">
          <label for="em-when">Start</label>
          <input id="em-when" type="datetime-local" value="${escapeHTML(whenVal)}" />
        </div>
        <div class="field">
          <label for="em-dur">Duration</label>
          <select id="em-dur">${durOpts}</select>
        </div>
      </div>
      ${attField}
      <div class="muted" style="font-size:12px;">Updates this app's record of the meeting.</div>
      <div id="em-out"></div>
    </div>
    <div class="modal-foot">
      <button class="btn-ghost" id="em-cancel" type="button" style="padding:8px 14px;">Cancel</button>
      <button class="pull-btn" id="em-save" type="button">Save changes</button>
    </div>`, brand);
  modal.querySelector("#em-x").addEventListener("click", closeModal);
  modal.querySelector("#em-cancel").addEventListener("click", closeModal);
  modal.querySelector("#em-save").addEventListener("click", () => submitEditMeeting(modal, m));
}

async function submitEditMeeting(modal, m) {
  const btn = modal.querySelector("#em-save");
  const out = modal.querySelector("#em-out");
  const title = modal.querySelector("#em-title").value.trim() || "Meeting";
  const whenVal = modal.querySelector("#em-when").value;
  const duration = Number(modal.querySelector("#em-dur").value) || 30;
  const attEl = modal.querySelector("#em-att");
  const attendees = attEl
    ? attEl.value.split(/[\s,;]+/).map((s) => s.trim()).filter((s) => s.includes("@"))
    : (m.attendees || []);
  let start = null;
  if (whenVal) {
    const d = new Date(whenVal);
    if (!isNaN(d)) start = d.toISOString();
  }
  btn.disabled = true;
  btn.classList.add("busy");
  btn.innerHTML = `<span class="pull-ic">⟳</span> Saving…`;
  try {
    const r = await api("/providers/created-meetings/" + m.id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, start, duration_minutes: duration, attendees }),
    });
    closeModal();
    if (r && r.notify && r.notify.error) {
      toast(`Meeting updated, but participants weren't notified: ${r.notify.error}`);
    } else if (r && r.notify && r.notify.sent) {
      toast(`Meeting updated · ${r.notify.sent} participant${r.notify.sent === 1 ? "" : "s"} notified.`);
    } else {
      toast("Meeting updated.");
    }
    await loadCreatedMeetings();
  } catch (e) {
    out.innerHTML = `<div class="err-box" style="margin-top:8px;">${escapeHTML(e.message)}</div>`;
    btn.disabled = false;
    btn.classList.remove("busy");
    btn.innerHTML = "Save changes";
  }
}

// Scheduled meetings pulled straight from the connected Google calendar (NOT
// just in-app created ones). Auto-loads whenever Google Meet is connected so the
// user sees their upcoming Meet meetings without opening the Calendar modal.
async function loadCalendarPanel(connected) {
  const card = $("calendar-card");
  const wrap = $("calendar-list");
  if (!card || !wrap) return;
  if (!connected) {
    card.classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }
  card.classList.remove("hidden");
  wrap.innerHTML = `<div class="muted" style="padding:12px 16px;">Loading your Meet meetings…</div>`;
  try {
    const data = await api("/providers/google_meet/calendar");
    const events = data.events || [];
    if (!events.length) {
      wrap.innerHTML = `<div class="muted" style="padding:12px 16px;">No Google Meet meetings on your calendar in the last month or coming three weeks.</div>`;
      return;
    }
    const upcoming = events.filter((e) => !e.is_past);
    const past = events.filter((e) => e.is_past).reverse();
    let html = `<div class="cal-list" style="padding:10px 14px;">`;
    if (upcoming.length) html += `<div class="cal-group-label">Upcoming</div>` + upcoming.map(calRow).join("");
    if (past.length) html += `<div class="cal-group-label">Recent</div>` + past.map(calRow).join("");
    html += `</div>`;
    wrap.innerHTML = html;
  } catch (e) {
    wrap.innerHTML = `<div class="err-box" style="margin:10px 14px;">${escapeHTML(e.message)}</div>`;
  }
}

function openCreatedMeeting(id) {
  const m = CREATED.find((x) => x.id === id);
  if (!m) return;
  selectedCreatedId = id;
  selectedId = null;
  renderList();
  renderCreatedList();
  renderCreatedMeeting(m.provider, m);
}

// --- detail ---------------------------------------------------------------
async function openMeeting(id) {
  selectedCreatedId = null;
  renderCreatedList();
  selectedId = id;
  renderList();
  $("detail-empty").classList.add("hidden");
  const body = $("detail-body");
  body.classList.remove("hidden");
  body.innerHTML = '<div class="muted" style="padding:20px;">Loading…</div>';
  try {
    const m = await api("/" + id);
    renderDetail(m);
  } catch (e) {
    body.innerHTML = `<div class="err-box" style="margin:10px;">${escapeHTML(e.message)}</div>`;
  }
}

function renderDetail(m) {
  const body = $("detail-body");
  const label = PROVIDER_LABELS[m.provider] || m.provider;
  const when = m.started_at || m.created_at;
  body.innerHTML = `
    <div class="detail-head">
      <h2>${escapeHTML(m.title)}</h2>
      <button class="btn-ghost" id="btn-delete" type="button" style="padding:5px 12px; font-size:12px;">Delete</button>
    </div>
    <div class="detail-sub">
      <span class="pill ${escapeHTML(m.provider)}">${escapeHTML(label)}</span>
      &nbsp;${fmtDate(when)} · ${(m.speakers || []).length} speakers · ${(m.utterances || []).length} lines
    </div>
    <div class="seg">
      <button data-seg="speakers" class="${detailSeg === "speakers" ? "active" : ""}">Speakers</button>
      <button data-seg="transcript" class="${detailSeg === "transcript" ? "active" : ""}">Transcript</button>
    </div>
    <div id="seg-body"></div>`;
  $("btn-delete").addEventListener("click", () => deleteMeeting(m));
  body.querySelectorAll(".seg button").forEach((b) => {
    b.addEventListener("click", () => {
      detailSeg = b.dataset.seg;
      body.querySelectorAll(".seg button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      renderSeg(m);
    });
  });
  renderSeg(m);
}

function renderSeg(m) {
  const wrap = $("seg-body");
  if (detailSeg === "transcript") {
    const utts = m.utterances || [];
    if (!utts.length) {
      wrap.innerHTML = '<div class="muted" style="padding:14px 0;">No transcript text.</div>';
      return;
    }
    wrap.innerHTML = utts.map((u) =>
      `<div class="utt"><span class="u-spk">${escapeHTML(u.speaker)}:</span> ${escapeHTML(u.text)}</div>`
    ).join("");
    return;
  }
  // Speakers
  const speakers = m.speakers || [];
  if (!speakers.length) {
    wrap.innerHTML = '<div class="muted" style="padding:14px 0;">No speakers detected.</div>';
    return;
  }
  wrap.innerHTML = speakers.map((s, i) => {
    const initial = (s.name || s.speaker || "?").trim().charAt(0).toUpperCase();
    const conf = s.matched && s.confidence != null ? ` · ${Math.round(s.confidence * 100)}% match` : "";
    const tag = s.matched ? `<span class="spk-tag">${escapeHTML(s.name || "Known")}</span>` : "";
    return `<div class="spk-row">
      <div class="spk-id">${escapeHTML(initial)}</div>
      <div class="spk-main">
        <div class="spk-name">${escapeHTML(s.name || s.speaker)}</div>
        <div class="spk-meta">${escapeHTML(s.speaker)} · ${fmtDuration(s.talk_time_ms)} · ${s.utterance_count} lines${conf}</div>
      </div>
      ${tag}
      <button class="btn-ghost btn-assign" data-speaker="${escapeHTML(s.speaker)}" type="button" style="padding:5px 11px; font-size:12px;">${s.matched ? "Reassign" : "Name"}</button>
    </div>`;
  }).join("");
  wrap.querySelectorAll(".btn-assign").forEach((b) => {
    b.addEventListener("click", () => assignSpeaker(m, b.dataset.speaker));
  });
}

async function assignSpeaker(m, speaker) {
  const name = window.prompt(`Who is "${speaker}"? Enter their full name to recognize them across meetings.`);
  if (!name || !name.trim()) return;
  const email = window.prompt("Email (optional):", "") || null;
  try {
    await api("/" + m.id + "/assign-speaker", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speaker, canonical_name: name.trim(), email: email && email.trim() ? email.trim() : null }),
    });
    toast("Speaker saved to registry.");
    await openMeeting(m.id);
    await loadMeetings();
  } catch (e) {
    toast(e.message);
  }
}

async function deleteMeeting(m) {
  if (!window.confirm(`Delete "${m.title}"? This cannot be undone.`)) return;
  try {
    await api("/" + m.id, { method: "DELETE" });
    toast("Meeting deleted.");
    selectedId = null;
    $("detail-body").classList.add("hidden");
    $("detail-empty").classList.remove("hidden");
    await loadMeetings();
  } catch (e) {
    toast(e.message);
  }
}

// --- paste import ---------------------------------------------------------
async function doImport() {
  const content = $("m-text").value.trim();
  if (!content) { toast("Paste some content first."); return; }
  const btn = $("btn-import");
  btn.disabled = true;
  try {
    const m = await api("/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        kind: $("m-kind").value,
        title: $("m-title").value.trim() || null,
      }),
    });
    $("m-text").value = "";
    $("m-title").value = "";
    toast("Imported.");
    await loadMeetings();
    switchPrimary("meetings");
    openMeeting(m.id);
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}

// --- upload import --------------------------------------------------------
function wireDropzone() {
  const dz = $("dropzone");
  const input = $("file-input");
  dz.addEventListener("click", () => input.click());
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("drag");
    if (e.dataTransfer.files && e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
  });
  input.addEventListener("change", () => {
    if (input.files && input.files[0]) setFile(input.files[0]);
  });
}
function setFile(f) {
  pickedFile = f;
  $("dz-label").textContent = f.name;
}
async function doUpload() {
  if (!pickedFile) { toast("Choose a file first."); return; }
  const btn = $("btn-upload");
  btn.disabled = true;
  try {
    const fd = new FormData();
    fd.append("file", pickedFile);
    const title = $("u-title").value.trim();
    if (title) fd.append("title", title);
    const m = await api("/upload", { method: "POST", body: fd });
    pickedFile = null;
    $("file-input").value = "";
    $("u-title").value = "";
    $("dz-label").textContent = "Drop a transcript (.txt, .md, .srt, .vtt, .json, .eml) here, or click to browse.";
    toast("Imported.");
    await loadMeetings();
    switchPrimary("meetings");
    openMeeting(m.id);
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}

// --- providers ------------------------------------------------------------
const PROVIDER_BRAND = {
  zoom:        { mark: "Z", color: "#2D8CFF", shadow: "rgba(45,140,255,.35)" },
  google_meet: { mark: "M", color: "#00897B", shadow: "rgba(0,137,123,.35)" },
  ms_teams:    { mark: "T", color: "#5B5FC7", shadow: "rgba(91,95,199,.35)" },
};

function provCard(p) {
  const brand = PROVIDER_BRAND[p.provider] || { mark: (p.label || "?")[0], color: "#999", shadow: "rgba(0,0,0,.15)" };
  const styleVars = `--brand:${brand.color}; --brand-shadow:${brand.shadow};`;
  const esc = escapeHTML(p.provider);

  let dot, statusText, headAction = "", foot = "";
  if (!p.configured) {
    dot = "off";
    statusText = "Not available on this server";
    headAction = `<button class="mini-btn" disabled type="button" style="opacity:.55;">Unavailable</button>`;
  } else if (p.connected) {
    dot = "on";
    statusText = "Connected" + (p.account_label ? " · " + escapeHTML(p.account_label) : "");
    headAction = `<button class="icon-btn prov-disconnect" data-p="${esc}" type="button" title="Disconnect">✕</button>`;
    let extra = "";
    if (p.provider === "google_meet") {
      extra = `<button class="mini-btn prov-newmeet" data-p="${esc}" type="button"><span>＋</span> New meeting</button>
         <button class="mini-btn prov-calendar" data-p="${esc}" type="button"><span>▦</span> Calendar</button>`;
    } else if (p.provider === "zoom" || p.provider === "ms_teams") {
      extra = `<button class="mini-btn prov-newmeet" data-p="${esc}" type="button"><span>＋</span> New meeting</button>`;
    }
    const primaryBtn = `<button class="pull-btn prov-sync" data-p="${esc}" type="button"><span class="pull-ic">⟳</span> Pull recordings</button>`;
    foot = `<div class="prov-foot">
      ${primaryBtn}
      ${extra}
    </div>`;
  } else if (p.needs_reconnect) {
    dot = "warn";
    statusText = "Connection expired";
    headAction = `<button class="mini-btn prov-connect" data-p="${esc}" type="button" style="border-color:var(--brand); color:var(--brand);">Reconnect</button>`;
  } else {
    dot = "off";
    statusText = "Not connected";
    headAction = `<button class="pull-btn prov-connect" data-p="${esc}" type="button">Connect</button>`;
  }

  return `<div class="prov-card ${p.connected ? "connected" : ""}" style="${styleVars}">
    <div class="prov-head">
      <div class="prov-logo">${escapeHTML(brand.mark)}</div>
      <div class="prov-main">
        <div class="prov-name">${escapeHTML(p.label)}</div>
        <div class="prov-status"><span class="prov-dot ${dot}"></span>${statusText}</div>
      </div>
      <div class="prov-actions">${headAction}</div>
    </div>
    ${foot}
  </div>`;
}

async function loadProviders() {
  const wrap = $("providers-list");
  try {
    const data = await api("/providers/status");
    PROVIDERS_STATUS = data.providers || [];
    ANY_PROVIDER_CONNECTED = PROVIDERS_STATUS.some((p) => p.connected);
    renderProviderPanel();
    renderCreatedList();
  } catch (e) {
    if (wrap) wrap.innerHTML = `<div class="err-box">${escapeHTML(e.message)}</div>`;
    PROVIDERS_STATUS = [];
    ANY_PROVIDER_CONNECTED = false;
    loadCalendarPanel(false);
    renderCreatedList();
  }
}

// Render only the connection card for the provider whose sub-tab is in focus
// (and the calendar panel when that provider is Google Meet). The provider
// status list is fetched once by loadProviders and cached in PROVIDERS_STATUS.
function renderProviderPanel() {
  // Reflect each provider's connection state on its sub-tab dot.
  document.querySelectorAll(".prov-tab").forEach((t) => {
    const sp = PROVIDERS_STATUS.find((x) => x.provider === t.dataset.prov);
    const dot = t.querySelector(".pt-dot");
    if (!dot) return;
    const brand = PROVIDER_BRAND[t.dataset.prov];
    dot.style.background = sp && sp.connected
      ? (brand ? brand.color : "var(--pt)")
      : "var(--border-strong, #c9c9c9)";
  });
  const wrap = $("providers-list");
  if (!wrap) return;
  const p = PROVIDERS_STATUS.find((x) => x.provider === selectedProvider);
  if (!p) {
    wrap.innerHTML = `<div class="skel-wrap"><div class="skel med"></div><div class="skel short"></div></div>`;
    loadCalendarPanel(false);
    return;
  }
  wrap.innerHTML = provCard(p);
  wrap.querySelectorAll(".prov-connect").forEach((b) =>
    b.addEventListener("click", () => connectProvider(b.dataset.p)));
  wrap.querySelectorAll(".prov-disconnect").forEach((b) =>
    b.addEventListener("click", () => disconnectProvider(b.dataset.p)));
  wrap.querySelectorAll(".prov-sync").forEach((b) =>
    b.addEventListener("click", () => syncProvider(b.dataset.p, b)));
  wrap.querySelectorAll(".prov-newmeet").forEach((b) =>
    b.addEventListener("click", () => openCreateMeetingModal(b.dataset.p)));
  wrap.querySelectorAll(".prov-calendar").forEach((b) =>
    b.addEventListener("click", () => openCalendarModal()));
  loadCalendarPanel(selectedProvider === "google_meet" && p.connected);
}
async function connectProvider(provider) {
  try {
    const data = await api("/providers/" + provider + "/oauth/start");
    if (data.authorize_url) window.location.href = data.authorize_url;
  } catch (e) {
    toast(e.message);
  }
}
async function disconnectProvider(provider) {
  if (!window.confirm("Disconnect this provider for the whole workspace?")) return;
  try {
    await api("/providers/" + provider + "/disconnect", { method: "POST" });
    toast("Disconnected.");
    loadProviders();
    loadCreatedMeetings();
    loadCalendarPanel(false);
  } catch (e) {
    toast(e.message);
  }
}
async function syncProvider(provider, btn) {
  btn.disabled = true;
  btn.classList.add("busy");
  const orig = btn.innerHTML;
  btn.innerHTML = `<span class="pull-ic">⟳</span> Pulling…`;
  try {
    const r = await api("/providers/" + provider + "/sync", { method: "POST" });
    if (r.imported) toast(`✓ ${r.imported} new meeting${r.imported === 1 ? "" : "s"} pulled in.`);
    else if (r.fetched) toast(`Up to date — ${r.skipped} already imported.`);
    else toast("No new recordings with transcripts found.");
    await loadMeetings();
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.classList.remove("busy");
    btn.innerHTML = orig;
  }
}

// --- modal helpers --------------------------------------------------------
function closeModal() {
  const root = $("modal-root");
  const ov = root.querySelector(".modal-overlay");
  if (ov) ov.classList.remove("show");
  setTimeout(() => { root.innerHTML = ""; }, 180);
}
function openModal(innerHTML, brand) {
  const root = $("modal-root");
  const vars = brand ? `--brand:${brand.color}; --brand-shadow:${brand.shadow};` : "";
  root.innerHTML = `<div class="modal-overlay"><div class="modal" style="${vars}">${innerHTML}</div></div>`;
  const ov = root.querySelector(".modal-overlay");
  ov.addEventListener("click", (e) => { if (e.target === ov) closeModal(); });
  requestAnimationFrame(() => ov.classList.add("show"));
  return root.querySelector(".modal");
}

// --- create a meeting (Google Meet, Zoom, or Teams) ----------------------
const PROVIDER_LABEL = {
  zoom: "Zoom",
  google_meet: "Google Meet",
  ms_teams: "Microsoft Teams",
};
const INVITE_HINT = {
  google_meet: "Invitees are emailed an invitation with the join link automatically by Google Calendar.",
  ms_teams: "Invitees are emailed an invitation with the join link automatically by Outlook.",
  zoom: "Invitees are emailed a branded invitation with the join link and a calendar attachment from this app.",
};
function openCreateMeetingModal(provider) {
  provider = provider || "google_meet";
  const brand = PROVIDER_BRAND[provider] || PROVIDER_BRAND.google_meet;
  const label = PROVIDER_LABEL[provider] || "Google Meet";
  const hint = INVITE_HINT[provider] || INVITE_HINT.google_meet;
  const attField = `
      <div class="field">
        <label for="cm-att">Invite (comma or space separated emails, optional)</label>
        <input id="cm-att" type="text" placeholder="alex@acme.com, jordan@acme.com" />
        <div class="muted" style="font-size:11px; margin-top:4px;">${escapeHTML(hint)}</div>
      </div>`;
  const modal = openModal(`
    <div class="modal-head">
      <div class="prov-logo">${escapeHTML(brand.mark)}</div>
      <h3>New ${escapeHTML(label)}</h3>
      <button class="modal-x" id="cm-x" type="button">×</button>
    </div>
    <div class="modal-body">
      <div class="field">
        <label for="cm-title">Title</label>
        <input id="cm-title" type="text" placeholder="e.g. Acme intro call" value="Meeting" />
      </div>
      <div class="grid-2">
        <div class="field">
          <label for="cm-when">Start (leave blank = now)</label>
          <input id="cm-when" type="datetime-local" />
        </div>
        <div class="field">
          <label for="cm-dur">Duration</label>
          <select id="cm-dur">
            <option value="15">15 min</option>
            <option value="30" selected>30 min</option>
            <option value="45">45 min</option>
            <option value="60">1 hour</option>
            <option value="90">1.5 hours</option>
          </select>
        </div>
      </div>
      ${attField}
      <div id="cm-out"></div>
    </div>
    <div class="modal-foot">
      <button class="btn-ghost" id="cm-cancel" type="button" style="padding:8px 14px;">Cancel</button>
      <button class="pull-btn" id="cm-create" type="button">Create meeting</button>
    </div>`, brand);

  modal.querySelector("#cm-x").addEventListener("click", closeModal);
  modal.querySelector("#cm-cancel").addEventListener("click", closeModal);
  modal.querySelector("#cm-create").addEventListener("click", () => submitCreateMeeting(modal, provider));
}

async function submitCreateMeeting(modal, provider) {
  provider = provider || "google_meet";
  const label = PROVIDER_LABEL[provider] || "Google Meet";
  const btn = modal.querySelector("#cm-create");
  const out = modal.querySelector("#cm-out");
  const title = modal.querySelector("#cm-title").value.trim() || "Meeting";
  const whenVal = modal.querySelector("#cm-when").value;
  const duration = Number(modal.querySelector("#cm-dur").value) || 30;
  const attEl = modal.querySelector("#cm-att");
  const attendees = attEl
    ? attEl.value.split(/[\s,;]+/).map((s) => s.trim()).filter((s) => s.includes("@"))
    : [];
  let start = null;
  if (whenVal) {
    const d = new Date(whenVal);
    if (!isNaN(d)) start = d.toISOString();
  }
  btn.disabled = true;
  btn.classList.add("busy");
  btn.innerHTML = `<span class="pull-ic">⟳</span> Creating…`;
  try {
    const r = await api("/providers/" + provider + "/create-meeting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, start, duration_minutes: duration, attendees }),
    });
    closeModal();
    if (r.invite && r.invite.error) {
      toast(`${label} created, but invitations weren't sent: ${r.invite.error}`);
    } else if (r.invite && r.invite.sent) {
      toast(`${label} created · ${r.invite.sent} invitation${r.invite.sent === 1 ? "" : "s"} sent.`);
    } else {
      toast(label + " created.");
    }
    // Reload the persisted list and select the new row so the right-panel
    // detail tracks selectedCreatedId — that lets a later disconnect clear it.
    await loadCreatedMeetings();
    if (CREATED.length) openCreatedMeeting(CREATED[0].id);
    else renderCreatedMeeting(provider, r);
  } catch (e) {
    out.innerHTML = `<div class="err-box" style="margin-top:4px;">${escapeHTML(e.message)}</div>`;
    btn.disabled = false;
    btn.classList.remove("busy");
    btn.innerHTML = "Create meeting";
  }
}

// Show a freshly-created (not-yet-imported) meeting in the right detail panel.
function renderCreatedMeeting(provider, r) {
  selectedId = null;
  renderList();
  $("detail-empty").classList.add("hidden");
  const body = $("detail-body");
  body.classList.remove("hidden");
  const label = PROVIDER_LABELS[provider] || provider;
  const link = safeUrl(r._url || r.html_link || "");
  const dur = r.duration_minutes ? " · " + r.duration_minutes + " min" : "";
  const attendees = (r.attendees || []).filter(Boolean);
  const linkBlock = link
    ? `<div class="meet-link-row">
         <input type="text" readonly value="${escapeHTML(link)}" id="cm-link" />
         <button class="mini-btn" id="cm-copy" type="button">Copy</button>
         <a class="pull-btn" href="${escapeHTML(link)}" target="_blank" rel="noopener" style="text-decoration:none;">Join</a>
       </div>`
    : `<div class="muted" style="font-size:13px;">No join link was returned.</div>`;
  const attBlock = attendees.length
    ? `<div class="muted" style="font-size:12px; margin-top:12px;">Invitees: ${attendees.map(escapeHTML).join(", ")}</div>`
    : "";
  body.innerHTML = `
    <div class="detail-head">
      <h2>${escapeHTML(r.title || "Meeting")}</h2>
    </div>
    <div class="detail-sub">
      <span class="pill ${escapeHTML(provider)}">${escapeHTML(label)}</span>
      &nbsp;${r.start ? fmtDate(r.start) : "Starting now"}${dur}
    </div>
    <div class="meet-result" style="margin-top:16px;">
      <div class="mr-head" style="font-weight:600; font-size:13px;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg> Meeting created — share the link below</div>
      <div style="margin-top:10px;">${linkBlock}</div>
      ${attBlock}
    </div>`;
  const copyBtn = body.querySelector("#cm-copy");
  if (copyBtn) copyBtn.addEventListener("click", () => {
    const inp = body.querySelector("#cm-link");
    inp.select();
    navigator.clipboard?.writeText(inp.value).then(() => toast("Link copied.")).catch(() => {});
  });
}

// --- browse Google Calendar ----------------------------------------------
function calRow(ev) {
  const d = parseServerDate(ev.start);
  const day = d ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
  const time = d ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
  const att = (ev.attendees || []).length;
  const meta = att ? `${att} invitee${att === 1 ? "" : "s"}` : "No invitees";
  return `<div class="cal-row ${ev.is_past ? "past" : ""}">
    <div class="cal-when"><div class="cw-day">${escapeHTML(day)}</div><div class="cw-time">${escapeHTML(time)}</div></div>
    <div class="cal-main">
      <div class="cal-title">${escapeHTML(ev.title)}</div>
      <div class="cal-meta">${escapeHTML(meta)}</div>
    </div>
    <div class="cal-join">${safeUrl(ev.join_url)
      ? `<a class="mini-btn" href="${escapeHTML(safeUrl(ev.join_url))}" target="_blank" rel="noopener">Join</a>`
      : ""}</div>
  </div>`;
}

async function openCalendarModal() {
  const brand = PROVIDER_BRAND.google_meet;
  const modal = openModal(`
    <div class="modal-head">
      <div class="prov-logo">M</div>
      <h3>Calendar meetings</h3>
      <button class="modal-x" id="cal-x" type="button">×</button>
    </div>
    <div class="modal-body" id="cal-body">
      <div class="muted" style="padding:10px 0;">Loading your Meet meetings…</div>
    </div>`, brand);
  modal.querySelector("#cal-x").addEventListener("click", closeModal);

  const body = modal.querySelector("#cal-body");
  try {
    const data = await api("/providers/google_meet/calendar");
    const events = data.events || [];
    if (!events.length) {
      body.innerHTML = `<div class="muted" style="padding:10px 0;">No Google Meet meetings on your calendar in the last month or coming three weeks.</div>`;
      return;
    }
    const upcoming = events.filter((e) => !e.is_past);
    const past = events.filter((e) => e.is_past).reverse();
    let html = `<div class="cal-list">`;
    if (upcoming.length) html += `<div class="cal-group-label">Upcoming</div>` + upcoming.map(calRow).join("");
    if (past.length) html += `<div class="cal-group-label">Recent</div>` + past.map(calRow).join("");
    html += `</div>`;
    body.innerHTML = html;
  } catch (e) {
    body.innerHTML = `<div class="err-box">${escapeHTML(e.message)}</div>`;
  }
}

// --- speakers registry ----------------------------------------------------
async function loadSpeakers() {
  const wrap = $("speakers-list");
  try {
    const data = await api("/speakers");
    const speakers = data.speakers || [];
    if (!speakers.length) {
      wrap.innerHTML = '<div class="muted" style="padding:8px 0;">No saved speakers yet.</div>';
      return;
    }
    wrap.innerHTML = speakers.map((s) => `<div class="spk-row">
      <div class="spk-id">${escapeHTML((s.canonical_name || "?").charAt(0).toUpperCase())}</div>
      <div class="spk-main">
        <div class="spk-name">${escapeHTML(s.canonical_name)}</div>
        <div class="spk-meta">${escapeHTML(s.email || "")}${s.email ? " · " : ""}${s.sample_count} sample${s.sample_count === 1 ? "" : "s"}</div>
      </div>
      <button class="btn-ghost spk-del" data-id="${s.id}" type="button" style="padding:5px 11px; font-size:12px;">Remove</button>
    </div>`).join("");
    wrap.querySelectorAll(".spk-del").forEach((b) =>
      b.addEventListener("click", () => deleteSpeaker(Number(b.dataset.id))));
  } catch (e) {
    wrap.innerHTML = `<div class="err-box">${escapeHTML(e.message)}</div>`;
  }
}
async function deleteSpeaker(id) {
  if (!window.confirm("Remove this speaker from the registry?")) return;
  try {
    await api("/speakers/" + id, { method: "DELETE" });
    toast("Removed.");
    loadSpeakers();
  } catch (e) {
    toast(e.message);
  }
}

// --- toast OAuth callback result -----------------------------------------
function handleCallbackParams() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("meeting") === "connected") toast("Provider connected.");
  const err = params.get("meeting_error");
  if (err) toast("Connection failed: " + err);
  if (params.has("meeting") || params.has("meeting_error")) {
    window.history.replaceState({}, "", window.location.pathname);
    // Returning from a provider OAuth flow — land the user on the Meetings tab
    // so they immediately see the connection result.
    switchPrimary("meetings");
  }
}

// "+ Add" header dropdown — quick access to the same intake modes as the
// primary tab chips (Paste / Upload / Meetings / Speakers).
function wireAddMenu() {
  const btn = $("btn-add");
  const menu = $("add-menu");
  if (!btn || !menu) return;
  const close = () => {
    menu.classList.add("hidden");
    btn.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
  };
  const open = () => {
    menu.classList.remove("hidden");
    btn.classList.add("open");
    btn.setAttribute("aria-expanded", "true");
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.classList.contains("hidden")) open();
    else close();
  });
  menu.querySelectorAll("button[data-add]").forEach((item) => {
    item.addEventListener("click", () => {
      switchPrimary(item.dataset.add);
      close();
    });
  });
  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target) && e.target !== btn) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
}

// Deep-link from the "All Meetings" tab: /imported-meetings?id=<id> opens that
// meeting's detail on the Meetings sub-tab.
function handleDeepLink() {
  const id = new URLSearchParams(window.location.search).get("id");
  if (!id) return;
  const numId = /^\d+$/.test(id) ? Number(id) : id;
  switchPrimary("meetings");
  openMeeting(numId);
}

function init() {
  wirePrimaryTabs();
  wireProviderTabs();
  wireAddMenu();
  wireDropzone();
  $("btn-import").addEventListener("click", doImport);
  $("btn-upload").addEventListener("click", doUpload);
  $("btn-refresh").addEventListener("click", loadMeetings);
  $("btn-spk-refresh").addEventListener("click", loadSpeakers);
  const calRefresh = $("btn-cal-refresh");
  if (calRefresh) calRefresh.addEventListener("click", () => loadCalendarPanel(true));
  handleCallbackParams();
  loadMeetings().then(handleDeepLink);
  loadCreatedMeetings();
  loadProviders();
  // Keep scheduled-meeting status (Scheduled/Ongoing/Completed) fresh without a
  // manual refresh — only when the tab is visible and no modal is open.
  setInterval(() => {
    if (document.hidden) return;
    if (document.querySelector("#modal-root .modal-overlay")) return;
    loadCreatedMeetings();
  }, 60000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
