const API = "";

const $ = (id) => document.getElementById(id);
let pollTimer = null;
let selectedId = null;

function escapeHTML(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The backend stores created_at as naive UTC. If the ISO string lacks a
// timezone marker, JavaScript would otherwise treat it as local time and
// shift the displayed clock by the user's UTC offset — append "Z" so the
// browser converts it correctly into the viewer's local timezone.
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

// ---- Speaker breakdown (parsed from diarized transcript) ----------------
//
// Diarized transcripts are stored as lines like:
//   [00:12–00:18] Speaker 0: Hello there...
// We parse those timestamps to compute each speaker's share of speaking time
// so the dashboard can show the same chips + stacked bar as Quick transcribe,
// without needing a DB migration.

const SPEAKER_COLORS = ["#10b981", "#8b5cf6", "#f59e0b", "#3b82f6", "#ec4899", "#14b8a6"];
// Diarized transcripts come in two shapes the dashboard must both parse:
//   range : "[MM:SS–MM:SS] Speaker N: …"        (manual-marker / Deepgram flow)
//   point : "[MM:SS] Speaker N (rep): …"        (AI auto-detect long-capture flow)
// Minutes can exceed two digits for long captures (e.g. "105:30"), and the AI
// flow tags rep speakers with a " (rep)" suffix before the colon. Both must be
// tolerated or no speaker breakdown renders.
const DIARIZED_RANGE_RE = /^\[(\d+):(\d{2})\s*[–\-]\s*(\d+):(\d{2})\]\s*(Speaker\s+\S+?)\s*(?:\(rep\))?\s*:/i;
const DIARIZED_POINT_RE = /^\[(\d+):(\d{2})\]\s*(Speaker\s+\S+?)\s*(?:\(rep\))?\s*:/i;
// Point-format lines carry no end time; cap each turn's estimated talk time at
// this many seconds so one long pause before the next line can't dominate.
const POINT_TURN_CAP_SEC = 120;

// ---- Custom speaker names (per conversation, browser-local) -------------
// Stored in localStorage so renaming "Speaker A" to "Ahmed" persists across
// reloads without requiring a backend column or migration. Keys are scoped
// by conversation id so the same Deepgram "Speaker 0" can map to different
// people in different conversations.
const SPEAKER_NAMES_KEY = "booth_speaker_names_v1";

function loadSpeakerNames() {
  try {
    return JSON.parse(localStorage.getItem(SPEAKER_NAMES_KEY) || "{}") || {};
  } catch {
    return {};
  }
}
function saveSpeakerNames(obj) {
  try { localStorage.setItem(SPEAKER_NAMES_KEY, JSON.stringify(obj)); } catch {}
}
// Raw is the diarizer's original label, e.g. "Speaker 0". We use it (not the
// A/B/C alias) as the storage key so the mapping survives if first-appearance
// order ever changes.
function getSpeakerName(convId, raw) {
  if (convId == null) return "";
  const all = loadSpeakerNames();
  return (all[`${convId}:${raw}`] || "").trim();
}
// Pulls a GPT-detected name (from conversation.analysis.speaker_names) when
// the user hasn't set a manual override. Manual overrides always win so
// users can correct mis-detections without losing them on reload.
function getAutoSpeakerName(analysis, raw) {
  if (!analysis) return "";
  const names = analysis.speaker_names;
  if (!names || typeof names !== "object") return "";
  const v = names[raw];
  return (typeof v === "string" ? v : "").trim();
}
function resolveSpeakerName(convId, analysis, raw) {
  return getSpeakerName(convId, raw) || getAutoSpeakerName(analysis, raw);
}
function setSpeakerName(convId, raw, name) {
  if (convId == null) return;
  const all = loadSpeakerNames();
  const k = `${convId}:${raw}`;
  const v = (name || "").trim();
  if (v) all[k] = v; else delete all[k];
  saveSpeakerNames(all);
}

function speakerLabelFromRaw(raw, index) {
  const m = /Speaker\s+(\d+)/i.exec(String(raw || ""));
  if (!m) return raw || `Speaker ${String.fromCharCode(65 + index)}`;
  const n = parseInt(m[1], 10);
  return `Speaker ${String.fromCharCode(65 + (isNaN(n) ? index : n))}`;
}

function parseSpeakerStats(transcript) {
  if (!transcript || typeof transcript !== "string") return [];
  // Pass 1: turn each diarized line into {speaker, start, end|null}. Range lines
  // carry their own end; point lines (AI flow) get it inferred in pass 2.
  const turns = [];
  for (const line of transcript.split(/\r?\n/)) {
    const t = line.trim();
    const range = DIARIZED_RANGE_RE.exec(t);
    if (range) {
      turns.push({
        speaker: range[5],
        start: parseInt(range[1], 10) * 60 + parseInt(range[2], 10),
        end: parseInt(range[3], 10) * 60 + parseInt(range[4], 10),
      });
      continue;
    }
    const point = DIARIZED_POINT_RE.exec(t);
    if (point) {
      turns.push({
        speaker: point[3],
        start: parseInt(point[1], 10) * 60 + parseInt(point[2], 10),
        end: null,
      });
    }
  }
  if (!turns.length) return [];
  // Pass 2: estimate each point-format turn's end from the next turn's start
  // (capped), so "how much they talk" is meaningful even without explicit ends.
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].end != null) continue;
    const next = turns[i + 1];
    if (next && next.start >= turns[i].start) {
      turns[i].end = Math.min(next.start, turns[i].start + POINT_TURN_CAP_SEC);
    } else {
      turns[i].end = turns[i].start;
    }
  }

  const totals = new Map();
  for (const turn of turns) {
    const dur = Math.max(0, turn.end - turn.start);
    const cur = totals.get(turn.speaker) || { speaker: turn.speaker, seconds: 0, count: 0 };
    cur.seconds += dur;
    cur.count += 1;
    totals.set(turn.speaker, cur);
  }
  const arr = [...totals.values()];
  const sum = arr.reduce((a, s) => a + s.seconds, 0) || 1;
  return arr
    .map((s) => ({ ...s, percent: Math.round((s.seconds / sum) * 1000) / 10 }))
    .sort((a, b) => b.seconds - a.seconds);
}

// Rewrite "Speaker 0/1/2..." → custom name (if set) or "Speaker A/B/C..."
// inside the transcript text itself so the rendered transcript matches the
// chip labels. Order is by first appearance, not numeric index, so the
// alias stays consistent even if Deepgram skips an ID.
function relabelTranscriptSpeakers(transcript, convId, analysis) {
  if (!transcript || typeof transcript !== "string") return transcript || "";
  const order = new Map();
  let next = 0;
  return transcript.replace(/Speaker\s+(\d+)/g, (_m, num) => {
    if (!order.has(num)) {
      order.set(num, String.fromCharCode(65 + next));
      next += 1;
    }
    const raw = `Speaker ${num}`;
    const name = resolveSpeakerName(convId, analysis, raw);
    return name || `Speaker ${order.get(num)}`;
  });
}

function fmtDateDMYHM(iso) {
  const d = parseServerDate(iso);
  if (!d) return "";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()} ${hh}:${mi}`;
}

function renderSpeakerBreakdown(transcript, createdAt, convId, analysis) {
  const stats = parseSpeakerStats(transcript);
  if (stats.length < 2) return "";

  const decorated = stats.map((s, i) => {
    const fallback = speakerLabelFromRaw(s.speaker, i);
    const manual = getSpeakerName(convId, s.speaker);
    const auto = getAutoSpeakerName(analysis, s.speaker);
    const resolved = manual || auto;
    return {
      ...s,
      raw: s.speaker,
      label: resolved || fallback,
      hasCustom: Boolean(manual),
      isAuto: Boolean(!manual && auto),
      color: SPEAKER_COLORS[i % SPEAKER_COLORS.length],
    };
  });

  // Collapse a long tail so the bar/legend stay readable.
  const KEEP = 3;
  let display = decorated;
  if (decorated.length > KEEP + 1) {
    const head = decorated.slice(0, KEEP);
    const tail = decorated.slice(KEEP);
    const tailPct = Math.round(tail.reduce((a, s) => a + s.percent, 0) * 10) / 10;
    display = [...head, { label: `${tail.length} other`, percent: tailPct, color: "#3b82f6", isOther: true }];
  }

  const chips = decorated
    .map(
      (s) =>
        `<button type="button" class="speaker-chip rename" data-raw="${escapeHTML(s.raw)}" title="Click to rename"><span class="dot" style="background:${s.color}"></span>${escapeHTML(s.label)}<span class="edit-ic" aria-hidden="true">✎</span></button>`
    )
    .join("");
  const segments = display
    .map(
      (s) =>
        `<span class="seg" style="width:${s.percent}%;background:${s.color}" title="${escapeHTML(s.label)} ${s.percent}%"></span>`
    )
    .join("");
  const legend = display
    .map(
      (s) =>
        s.isOther
          ? `<span class="legend-item"><span class="dot" style="background:${s.color}"></span><strong>${escapeHTML(s.label)}</strong> <span class="muted">${s.percent}%</span></span>`
          : `<button type="button" class="legend-item rename" data-raw="${escapeHTML(s.raw)}" title="Click to rename"><span class="dot" style="background:${s.color}"></span><strong>${escapeHTML(s.label)}</strong> <span class="muted">${s.percent}%</span></button>`
    )
    .join("");

  const dateStr = fmtDateDMYHM(createdAt);
  return `
    <div class="speaker-summary">
      <div class="speaker-chip-row">
        <span class="speaker-chip count"><span class="ic">◔</span>${decorated.length} speakers detected</span>
        ${chips}
      </div>
      <div class="speaker-bar">${segments}</div>
      <div class="speaker-legend">${legend}</div>
      <div class="speaker-footer muted">
        <span><span class="ic">◔</span> ${decorated.length} participants</span>
        ${dateStr ? `<span><span class="ic">▦</span> ${escapeHTML(dateStr)}</span>` : ""}
      </div>
    </div>
  `;
}

function fmtDuration(s) {
  if (s == null) return "—";
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}m ${sec}s`;
}

async function loadConfig() {
  try {
    const r = await fetch(`${API}/api/config`);
    const cfg = await r.json();
    const sub = $("event-subtitle");
    if (sub) sub.textContent = `${cfg.booth_name} · ${cfg.event_name}`;
    const brandSub = $("brand-subtitle");
    if (brandSub) brandSub.textContent = cfg.booth_name;
  } catch {
    /* non-fatal */
  }
}

function setStat(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

// Cache events so the filter dropdown can populate Day options without an
// extra fetch per change. Refreshed by loadEventsFilter().
let EVENTS_FILTER_CACHE = [];

async function loadEventsFilter() {
  try {
    const r = await fetch(`${API}/api/events`);
    if (!r.ok) return;
    EVENTS_FILTER_CACHE = await r.json();
    const sel = $("filter-event");
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = `<option value="">All events</option>` +
      EVENTS_FILTER_CACHE.map((e) => `<option value="${e.id}">${escapeHTML(e.name)}</option>`).join("");
    if (current && EVENTS_FILTER_CACHE.some((e) => String(e.id) === current)) {
      sel.value = current;
    }
    renderDayFilter();
  } catch {
    /* non-fatal — filter just stays empty */
  }
}

function renderDayFilter() {
  const eventId = $("filter-event").value;
  const daySel = $("filter-day");
  if (!eventId) {
    daySel.innerHTML = `<option value="">All days</option>`;
    daySel.disabled = true;
    return;
  }
  const ev = EVENTS_FILTER_CACHE.find((e) => String(e.id) === String(eventId));
  const days = (ev && ev.days) || [];
  daySel.disabled = false;
  daySel.innerHTML = `<option value="">All days</option>` +
    days.map((d) => `<option value="${d.id}">${escapeHTML(d.label || `Day ${d.day_number}`)}</option>`).join("");
}

// When a long-capture session row is clicked, the conversations list is
// scoped to just that session's derived conversations. Holds {id, name} or
// null. The event/day/date filters are ignored while a session is selected.
let sessionFilter = null;
// Cached sessions payload so the conversations "Source" column can be
// re-decorated after every loadList() re-render (not just the first load).
let SESSIONS_CACHE = [];

function buildListQuery() {
  if (sessionFilter) {
    return `?session_id=${encodeURIComponent(sessionFilter.id)}`;
  }
  const params = new URLSearchParams();
  const evt = $("filter-event").value;
  const day = $("filter-day").value;
  const from = $("filter-from").value;
  const to = $("filter-to").value;
  // event_day_id wins over event_id on the backend, but only send the more
  // specific one to keep the URL clean.
  if (day) params.set("event_day_id", day);
  else if (evt) params.set("event_id", evt);
  if (from) params.set("from_date", from);
  if (to) params.set("to_date", to);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

async function loadList() {
  try {
    const r = await fetch(`${API}/api/conversations${buildListQuery()}`);
    if (!r.ok) throw new Error(`List failed (${r.status})`);
    const items = await r.json();

    // Top-row KPI tiles.
    setStat("stat-conversations", String(items.length));
    setStat("stat-hot", String(items.filter((c) => c.lead_temperature === "hot").length));
    setStat("stat-warm", String(items.filter((c) => c.lead_temperature === "warm").length));

    const body = $("conv-body");
    const statusEl = $("list-status");
    statusEl.classList.remove("hidden");
    if (items.length === 0) {
      const filtered = Boolean(buildListQuery());
      statusEl.textContent = sessionFilter
        ? `No conversations were generated within "${sessionFilter.name}" yet.`
        : filtered
          ? "No conversations match the current filters."
          : "No conversations yet. Use the booth page or upload a long-capture session.";
      $("conv-table").classList.add("hidden");
      return;
    }
    statusEl.classList.add("hidden");
    $("conv-table").classList.remove("hidden");
    body.innerHTML = items
      .map(
        (c) => `
        <tr data-id="${c.id}" class="${c.id === selectedId ? "selected" : ""}">
          <td>
            <div><strong>${escapeHTML((c.topic || "").trim() || c.visitor_name || `Conversation #${c.id}`)}</strong></div>
            <div class="muted">${escapeHTML(c.visitor_company || "—")}${
              c.event_name || c.event_day_label
                ? ` · ${escapeHTML([c.event_name, c.event_day_label].filter(Boolean).join(" · "))}`
                : ""
            }</div>
          </td>
          <td data-label="Score">
            ${c.lead_score != null ? `<strong>${c.lead_score}</strong>` : "<span class='muted'>—</span>"}
            ${c.lead_temperature ? ` <span class="temp ${c.lead_temperature}">${c.lead_temperature}</span>` : ""}
          </td>
          <td data-label="Status"><span class="pill ${c.status}">${c.status}</span></td>
          <td class="muted" data-source="${c.id}" data-label="Source">—</td>
          <td class="muted" data-label="When">${fmtDate(c.created_at)}</td>
        </tr>`
      )
      .join("");

    body.querySelectorAll("tr").forEach((tr) => {
      tr.addEventListener("click", () => loadDetail(Number(tr.dataset.id)));
    });
    decorateConvSources();
  } catch (e) {
    $("list-status").textContent = "Failed to load: " + e.message;
  }
}

// Decorate the conversations "Source" column with the originating session
// (or "Booth"). Runs after every loadList() render so the labels survive
// re-renders, using the cached sessions payload.
function decorateConvSources() {
  const sessionByConvId = new Map();
  for (const s of SESSIONS_CACHE) {
    for (const cid of s.derived_conversation_ids) sessionByConvId.set(cid, s);
  }
  document.querySelectorAll("td[data-source]").forEach((cell) => {
    const cid = Number(cell.dataset.source);
    const sess = sessionByConvId.get(cid);
    cell.textContent = sess ? `Session #${sess.id}` : "Booth";
  });
}

// Scope the conversations list to a single long-capture session (or clear
// the scope when passed null).
function setSessionFilter(session) {
  sessionFilter = session ? { id: session.id, name: session.name } : null;
  const banner = $("session-filter-banner");
  const textEl = $("session-filter-text");
  if (banner && textEl) {
    if (sessionFilter) {
      textEl.textContent = `Showing conversations from "${sessionFilter.name}"`;
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }
  // Highlight the selected session row.
  document.querySelectorAll("#sessions-body tr").forEach((tr) => {
    tr.classList.toggle(
      "selected",
      Boolean(sessionFilter) && Number(tr.dataset.sessionId) === sessionFilter.id
    );
  });
  loadList();
}

async function loadSessions() {
  try {
    const r = await fetch(`${API}/api/sessions`);
    if (!r.ok) return;
    const sessions = await r.json();
    SESSIONS_CACHE = sessions;
    setStat("stat-sessions", String(sessions.length));
    const card = $("sessions-card");
    const body = $("sessions-body");
    if (!sessions.length) {
      card.classList.add("hidden");
      return;
    }
    card.classList.remove("hidden");
    body.innerHTML = sessions
      .map((s) => {
        const visitorStarts = s.markers.filter((m) => m.marker_type === "visitor_start").length;
        const dur = s.duration_seconds != null
          ? `${Math.floor(s.duration_seconds / 60)}m ${Math.round(s.duration_seconds % 60)}s`
          : "—";
        const isSelected = sessionFilter && sessionFilter.id === s.id;
        return `
          <tr data-session-id="${s.id}" class="${isSelected ? "selected" : ""}">
            <td>
              <div><strong>${escapeHTML(s.name)}</strong></div>
              <div class="muted">${escapeHTML(s.staff_name || "—")}</div>
            </td>
            <td data-label="Status"><span class="pill ${s.status}">${s.status}</span></td>
            <td class="muted" data-label="Duration">${dur}</td>
            <td class="muted" data-label="Markers">${visitorStarts} visitor(s)</td>
            <td class="muted" data-label="Conversations">${s.derived_conversation_ids.length}</td>
            <td class="muted" data-label="When">${fmtDate(s.created_at)}</td>
          </tr>`;
      })
      .join("");

    // Clicking a session scopes the conversations list to just that session's
    // derived conversations.
    body.querySelectorAll("tr").forEach((tr) => {
      tr.addEventListener("click", () => {
        const id = Number(tr.dataset.sessionId);
        if (sessionFilter && sessionFilter.id === id) {
          setSessionFilter(null);
        } else {
          setSessionFilter(sessions.find((s) => s.id === id) || null);
        }
      });
    });

    // The conversations "Source" column is decorated from the cached session
    // payload (see decorateConvSources), so labels survive list re-renders.
    decorateConvSources();
  } catch {
    /* non-fatal */
  }
}

async function loadDetail(id) {
  selectedId = id;
  $("detail-title").textContent = `Conversation #${id}`;
  $("detail-body").innerHTML = "<div class='muted'>Loading…</div>";
  try {
    const r = await fetch(`${API}/api/conversations/${id}`);
    if (!r.ok) throw new Error(`Load failed (${r.status})`);
    const c = await r.json();
    renderDetail(c);
  } catch (e) {
    $("detail-body").innerHTML = `<div class='alert error'>${escapeHTML(e.message)}</div>`;
  }
}

function renderDetail(c) {
  const a = c.analysis || {};

  // Title prefers the detected topic, then visitor name, then conversation #.
  // Topic comes from GPT analysis (analysis.topic) — see services/analysis.py.
  const topic = (c.topic || a.topic || "").trim();
  const visitorName = (c.visitor_name || "").trim();
  const titleText = topic || visitorName || `Conversation #${c.id}`;
  $("detail-title").textContent = titleText;
  const tagList = (arr) =>
    (arr || []).length
      ? `<ul class="tag-list">${arr.map((x) => `<li>${escapeHTML(x)}</li>`).join("")}</ul>`
      : '<span class="muted">—</span>';

  const errorBlock = c.status === "error"
    ? `<div class="alert error">Processing error: ${escapeHTML(c.error_message || "unknown")}</div>`
    : "";

  const pendingBlock =
    ["created", "uploaded", "queued", "transcribing", "analyzing"].includes(c.status)
      ? `<div class="alert info">Processing in progress (${escapeHTML(c.status)})… this view auto-refreshes.</div>`
      : "";

  $("detail-body").innerHTML = `
    ${errorBlock}
    ${pendingBlock}

    <div style="display: flex; gap: 16px; align-items: center; margin-bottom: 14px; flex-wrap: wrap;">
      <span class="pill ${c.status}">${c.status}</span>
      ${c.lead_score != null ? `<span><strong>Lead score:</strong> ${c.lead_score}/100</span>` : ""}
      ${c.lead_temperature ? `<span class="temp ${c.lead_temperature}">${c.lead_temperature}</span>` : ""}
      <span class="muted">${fmtDuration(c.duration_seconds)} · ${fmtDate(c.created_at)}</span>
    </div>

    ${renderSpeakerBreakdown(c.transcript, c.created_at, c.id, c.analysis)}

    ${a.summary ? `<h3>Summary</h3><div style="margin-bottom: 16px;">${escapeHTML(a.summary)}</div>` : ""}

    <h3>Lead profile</h3>
    <dl class="detail-grid" style="margin-bottom: 18px;">
      <dt>Intent</dt><dd>${escapeHTML(a.intent || "—")}</dd>
      <dt>Budget</dt><dd>${escapeHTML(a.budget_range || "—")}</dd>
      <dt>Urgency</dt><dd>${escapeHTML(a.urgency || "—")}</dd>
      <dt>Timeline</dt><dd>${escapeHTML(a.timeline || "—")}</dd>
      <dt>Buying role</dt><dd>${escapeHTML(a.buying_role || "—")}</dd>
      <dt>Sentiment</dt><dd>${escapeHTML(a.sentiment || "—")}</dd>
      <dt>Products</dt><dd>${tagList(a.products_discussed)}</dd>
      <dt>Pain points</dt><dd>${tagList(a.pain_points)}</dd>
      <dt>Competitors</dt><dd>${tagList(a.competitors_mentioned)}</dd>
      <dt>Discussion topics</dt><dd>${tagList(a.discussion_topics)}</dd>
      <dt>Next action</dt><dd>${escapeHTML(a.next_action || "—")}</dd>
    </dl>

    ${
      (a.key_quotes || []).length
        ? `<h3>Key quotes</h3><ul>${a.key_quotes.map((q) => `<li>"${escapeHTML(q)}"</li>`).join("")}</ul>`
        : ""
    }

    ${c.transcript
      ? `<h3>Transcript ${c.transcript_language ? `(${escapeHTML(c.transcript_language)})` : ""}</h3>
         <div style="background: var(--panel-2); padding: 14px; border-radius: 8px; font-size: 14px; line-height: 1.55; white-space: pre-wrap; max-height: 320px; overflow-y: auto;">${escapeHTML(relabelTranscriptSpeakers(c.transcript, c.id, c.analysis))}</div>`
      : '<h3>Transcript</h3><div class="muted">Not available yet.</div>'
    }

    <div class="button-row">
      ${c.status === "error" || c.status === "analyzed"
        ? `<button class="secondary" id="btn-reprocess">Re-run analysis</button>`
        : ""}
      ${c.status === "analyzed"
        ? `<button class="secondary" id="btn-hubspot">${c.hubspot_synced_at ? "Re-sync to HubSpot" : "Sync with HubSpot"}</button>`
        : ""}
      ${c.status === "analyzed"
        ? `<button class="secondary" id="btn-salesforce">${c.salesforce_synced_at ? "Re-sync to Salesforce" : "Sync with Salesforce"}</button>`
        : ""}
    </div>
    <div id="hubspot-status" class="muted" style="margin-top:8px;">${renderHubspotStatus(c)}</div>
    <div id="salesforce-status" class="muted" style="margin-top:8px;">${renderSalesforceStatus(c)}</div>
  `;

  // Rename-speaker handler. Delegated so a single listener covers every
  // chip + legend item in the speaker breakdown. Custom names persist in
  // localStorage (see SPEAKER_NAMES_KEY) and instantly re-render the panel
  // + transcript via renderDetail with the cached conversation object.
  document.querySelectorAll(".speaker-summary .rename").forEach((btn) => {
    btn.addEventListener("click", () => {
      const raw = btn.dataset.raw;
      if (!raw) return;
      const existing = getSpeakerName(c.id, raw);
      const fallback = btn.textContent.replace(/[\u2710\u270E\u270F✎]/g, "").trim();
      const next = prompt(`Name for "${fallback}"\n(leave blank to reset)`, existing);
      if (next === null) return; // user cancelled
      setSpeakerName(c.id, raw, next);
      renderDetail(c);
    });
  });

  const re = document.getElementById("btn-reprocess");
  if (re) {
    re.addEventListener("click", async () => {
      re.disabled = true;
      try {
        const r = await fetch(`${API}/api/conversations/${c.id}/process`, { method: "POST" });
        if (!r.ok) throw new Error("Reprocess failed");
        await loadDetail(c.id);
        loadList();
      } catch (e) {
        alert(e.message);
        re.disabled = false;
      }
    });
  }

  const hs = document.getElementById("btn-hubspot");
  if (hs) {
    hs.addEventListener("click", async () => {
      const status = document.getElementById("hubspot-status");
      hs.disabled = true;
      status.innerHTML = '<span class="muted">Syncing to HubSpot…</span>';
      try {
        const r = await fetch(`${API}/api/conversations/${c.id}/hubspot-sync`, { method: "POST" });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.detail || `Sync failed (${r.status})`);
        // Merge sync response into the cached conversation object so the
        // status line + button label refresh without a full reload.
        Object.assign(c, {
          hubspot_contact_id: data.contact_id || c.hubspot_contact_id,
          hubspot_company_id: data.company_id || c.hubspot_company_id,
          hubspot_note_id: data.note_id || c.hubspot_note_id,
          hubspot_deal_id: data.deal_id || c.hubspot_deal_id,
          hubspot_synced_at: data.synced_at || new Date().toISOString(),
          hubspot_sync_error: null,
          _hubspot_urls: {
            contact: data.contact_url || null,
            company: data.company_url || null,
            deal: data.deal_url || null,
          },
        });
        status.innerHTML = renderHubspotStatus(c);
        hs.textContent = "Re-sync to HubSpot";
      } catch (e) {
        status.innerHTML = `<span style="color: var(--danger, #ef4444);">${escapeHTML(e.message)}</span>`;
      } finally {
        hs.disabled = false;
      }
    });
  }

  const sf = document.getElementById("btn-salesforce");
  if (sf) {
    sf.addEventListener("click", async () => {
      const status = document.getElementById("salesforce-status");
      sf.disabled = true;
      status.innerHTML = '<span class="muted">Syncing to Salesforce…</span>';
      try {
        const r = await fetch(`${API}/api/conversations/${c.id}/salesforce-sync`, { method: "POST" });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.detail || `Sync failed (${r.status})`);
        // Merge sync response into the cached conversation object so the
        // status line + button label refresh without a full reload.
        Object.assign(c, {
          salesforce_contact_id: data.contact_id || c.salesforce_contact_id,
          salesforce_opportunity_id: data.opportunity_id || c.salesforce_opportunity_id,
          salesforce_synced_at: data.synced_at || new Date().toISOString(),
          salesforce_sync_error: null,
          _salesforce_urls: {
            contact: data.contact_url || null,
            account: data.account_url || null,
            opportunity: data.opportunity_url || null,
          },
        });
        status.innerHTML = renderSalesforceStatus(c);
        sf.textContent = "Re-sync to Salesforce";
      } catch (e) {
        status.innerHTML = `<span style="color: var(--danger, #ef4444);">${escapeHTML(e.message)}</span>`;
      } finally {
        sf.disabled = false;
      }
    });
  }
}

function renderHubspotStatus(c) {
  // Prefer fresh URLs from the just-completed sync, else fall back to
  // ids alone (we don't know the portal id when re-rendering from a list
  // payload, so we render an id-only chip instead of a broken link).
  if (c.hubspot_sync_error) {
    return `<span style="color: var(--danger, #ef4444);">HubSpot sync failed: ${escapeHTML(c.hubspot_sync_error)}</span>`;
  }
  if (!c.hubspot_synced_at && !c.hubspot_contact_id) return "";
  const urls = c._hubspot_urls || {};
  const when = c.hubspot_synced_at ? new Date(c.hubspot_synced_at).toLocaleString() : "";
  const parts = [];
  if (c.hubspot_contact_id) {
    parts.push(urls.contact
      ? `<a href="${urls.contact}" target="_blank" rel="noopener">Contact</a>`
      : `Contact #${escapeHTML(c.hubspot_contact_id)}`);
  }
  if (c.hubspot_company_id) {
    parts.push(urls.company
      ? `<a href="${urls.company}" target="_blank" rel="noopener">Company</a>`
      : `Company #${escapeHTML(c.hubspot_company_id)}`);
  }
  if (c.hubspot_deal_id) {
    parts.push(urls.deal
      ? `<a href="${urls.deal}" target="_blank" rel="noopener">Deal</a>`
      : `Deal #${escapeHTML(c.hubspot_deal_id)}`);
  }
  const joined = parts.length ? ` · ${parts.join(" · ")}` : "";
  return `<span>✓ Synced to HubSpot${when ? ` · ${escapeHTML(when)}` : ""}${joined}</span>`;
}

function renderSalesforceStatus(c) {
  // Prefer fresh URLs from the just-completed sync, else fall back to ids
  // alone (we don't know the instance URL when re-rendering from a list
  // payload, so we render an id-only chip instead of a broken link).
  if (c.salesforce_sync_error) {
    return `<span style="color: var(--danger, #ef4444);">Salesforce sync failed: ${escapeHTML(c.salesforce_sync_error)}</span>`;
  }
  if (!c.salesforce_synced_at && !c.salesforce_contact_id) return "";
  const urls = c._salesforce_urls || {};
  const when = c.salesforce_synced_at ? new Date(c.salesforce_synced_at).toLocaleString() : "";
  const parts = [];
  if (c.salesforce_contact_id) {
    parts.push(urls.contact
      ? `<a href="${urls.contact}" target="_blank" rel="noopener">Contact</a>`
      : `Contact #${escapeHTML(c.salesforce_contact_id)}`);
  }
  if (urls.account) {
    parts.push(`<a href="${urls.account}" target="_blank" rel="noopener">Account</a>`);
  }
  if (c.salesforce_opportunity_id) {
    parts.push(urls.opportunity
      ? `<a href="${urls.opportunity}" target="_blank" rel="noopener">Opportunity</a>`
      : `Opportunity #${escapeHTML(c.salesforce_opportunity_id)}`);
  }
  const joined = parts.length ? ` · ${parts.join(" · ")}` : "";
  return `<span>✓ Synced to Salesforce${when ? ` · ${escapeHTML(when)}` : ""}${joined}</span>`;
}

$("link-refresh").addEventListener("click", (e) => {
  e.preventDefault();
  loadAll();
  if (selectedId != null) loadDetail(selectedId);
});

$("link-export").addEventListener("click", (e) => {
  e.preventDefault();
  window.location.href = `${API}/api/conversations/export/csv`;
});

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    loadAll();
    if (selectedId != null) {
      // Only refresh the detail view if it's in a non-terminal state.
      const row = document.querySelector(`tr[data-id="${selectedId}"]`);
      if (row && row.querySelector(".pill")) {
        const pill = row.querySelector(".pill").className;
        if (/transcribing|analyzing|uploaded|queued|created/.test(pill)) {
          loadDetail(selectedId);
        }
      }
    }
  }, 4000);
}

async function loadAll() {
  await loadList();
  await loadSessions();
}

// --- Filter wiring -------------------------------------------------------
// Filters re-trigger loadList() on change. The day dropdown also re-renders
// when the event changes so it shows only that event's days.
["filter-event", "filter-day", "filter-from", "filter-to"].forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener("change", () => {
    if (id === "filter-event") renderDayFilter();
    // Switching to an event/day/date filter releases the session scope so the
    // two filtering modes don't silently conflict.
    if (sessionFilter) {
      setSessionFilter(null);
    } else {
      loadList();
    }
  });
});
const clearBtn = $("filter-clear");
if (clearBtn) {
  clearBtn.addEventListener("click", () => {
    $("filter-event").value = "";
    $("filter-day").value = "";
    $("filter-from").value = "";
    $("filter-to").value = "";
    renderDayFilter();
    setSessionFilter(null);
  });
}
const sessionFilterClear = $("session-filter-clear");
if (sessionFilterClear) {
  sessionFilterClear.addEventListener("click", () => setSessionFilter(null));
}

loadConfig();
loadEventsFilter();
loadAll();
startPolling();
