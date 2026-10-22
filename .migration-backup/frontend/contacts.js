// Contacts — flat list with search/filter + modal edit/delete.
// Mirrors the modal pattern used by /companies for visual consistency.

const $ = (id) => document.getElementById(id);
let allContacts = [];
let editingId = null;
let viewMode = localStorage.getItem("contacts_view") === "table" ? "table" : "cards";

document.addEventListener("DOMContentLoaded", () => {
  $("view-cards").addEventListener("click", () => setView("cards"));
  $("view-table").addEventListener("click", () => setView("table"));
  applyViewButtons();
  load();
  $("q").addEventListener("input", render);
  $("type-filter").addEventListener("change", render);
  $("source-filter").addEventListener("change", render);
  $("show-synthetic").addEventListener("change", render);
  $("btn-new").addEventListener("click", () => openModal(null));
  $("m-close").addEventListener("click", closeModal);
  $("m-cancel").addEventListener("click", closeModal);
  $("m-save").addEventListener("click", save);
  $("m-delete").addEventListener("click", del);
  $("m-research").addEventListener("click", runContactResearch);
  $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) closeModal(); });
});

function esc(s) { return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function showAlert(kind, msg) {
  const el = $("alert");
  if (!msg) { el.innerHTML = ""; return; }
  const div = document.createElement("div");
  div.className = "alert " + (kind || "");
  div.textContent = String(msg);
  el.innerHTML = "";
  el.appendChild(div);
}
function initials(name) {
  return (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0].toUpperCase()).join("") || "?";
}

async function load() {
  try {
    const r = await fetch("/api/visitors");
    if (!r.ok) throw new Error(`Load failed (${r.status})`);
    allContacts = await r.json();
    render();
    // Deep-link: /contacts?contact_id=N opens that contact's editor directly
    // (used by the bulk-scan results "Open" links).
    const cid = new URLSearchParams(location.search).get("contact_id");
    if (cid && allContacts.some((c) => String(c.id) === cid)) {
      openModal(parseInt(cid, 10));
    }
  } catch (err) {
    showAlert("error", err.message || String(err));
  }
}

// "Synthetic" contacts are visitor rows auto-created so a conversation/
// recording has an owner row to hang off — e.g. /transcribe (source
// "transcription", name = audio filename) and Plaud sync (source "plaud",
// name = recording title). They're not real people, so we hide them from the
// Contacts page by default. The "Show auto-created from transcripts &
// recordings" checkbox brings them back for debugging or cleanup.
const SYNTHETIC_SOURCES = ["transcription", "plaud"];
function isSynthetic(c) {
  return SYNTHETIC_SOURCES.includes(c.source)
    || /^Transcription:/i.test(c.name || "");
}

function filtered() {
  const q = $("q").value.trim().toLowerCase();
  const t = $("type-filter").value;
  const s = $("source-filter").value;
  const showSynth = $("show-synthetic").checked;
  return allContacts.filter((c) => {
    // When the user explicitly picks a synthetic source filter (Transcription
    // or Plaud) we honour that even with the checkbox off — otherwise the
    // option would appear to do nothing.
    if (!showSynth && !SYNTHETIC_SOURCES.includes(s) && isSynthetic(c)) return false;
    if (t && (c.contact_type || "lead") !== t) return false;
    if (s && (c.source || "manual") !== s) return false;
    if (!q) return true;
    const hay = [c.name, c.company, c.email, c.phone, c.designation, c.industry]
      .filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  });
}

// Persist + reflect the cards/table choice. Re-renders so a toggle swaps the
// visible view without re-fetching (data is already client-side).
function setView(mode) {
  viewMode = mode === "table" ? "table" : "cards";
  localStorage.setItem("contacts_view", viewMode);
  applyViewButtons();
  render();
}

function applyViewButtons() {
  $("view-cards").setAttribute("aria-pressed", String(viewMode === "cards"));
  $("view-table").setAttribute("aria-pressed", String(viewMode === "table"));
}

function render() {
  const list = filtered();
  $("count").textContent = `${list.length} of ${allContacts.length}`;
  const grid = $("grid");
  const tableWrap = $("table-wrap");
  const empty = $("empty");
  const isTable = viewMode === "table";

  if (list.length === 0) {
    grid.innerHTML = "";
    $("contact-tbody").innerHTML = "";
    grid.classList.add("hidden");
    tableWrap.classList.add("hidden");
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  grid.classList.toggle("hidden", isTable);
  tableWrap.classList.toggle("hidden", !isTable);

  if (isTable) {
    const tbody = $("contact-tbody");
    tbody.innerHTML = list.map(rowHTML).join("");
    tbody.querySelectorAll("tr").forEach((el) => {
      el.addEventListener("click", () => openModal(parseInt(el.dataset.id, 10)));
    });
  } else {
    grid.innerHTML = list.map(cardHTML).join("");
    grid.querySelectorAll(".contact-card").forEach((el) => {
      el.addEventListener("click", () => openModal(parseInt(el.dataset.id, 10)));
    });
  }
}

// contact_type is a free-form string on the backend, but only these three are
// valid. Restrict to an allowlist before using it as a CSS class / label so a
// crafted value can't break out of the HTML context (XSS-safe).
function safeType(c) {
  const t = String(c.contact_type || "lead").toLowerCase();
  return ["lead", "customer", "employee"].includes(t) ? t : "lead";
}

function cardHTML(c) {
  const type = safeType(c);
  return `
    <div class="contact-card" data-id="${c.id}">
      <div class="top">
        <div class="avatar-circle">${esc(initials(c.name))}</div>
        <div style="flex:1; min-width:0;">
          <h3>${esc(c.name)}</h3>
          <div class="sub">${esc(c.designation || "—")}${c.company ? " · " + esc(c.company) : ""}</div>
        </div>
      </div>
      <div class="badges">
        <span class="type-pill ${type}">${type}</span>
        ${c.source === "scan" ? `<span class="source-pill">⧈ scanned</span>` : ""}
      </div>
      ${(c.email || c.phone || c.linkedin_url) ? `
        <div class="meta">
          ${c.email ? `<span>✉ ${esc(c.email)}</span>` : ""}
          ${c.phone ? `<span>☎ ${esc(c.phone)}</span>` : ""}
          ${c.linkedin_url ? `<a href="${esc(c.linkedin_url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">in ↗</a>` : ""}
        </div>` : ""}
    </div>
  `;
}

function sourceLabel(c) {
  if (c.source === "scan") return "Scanned";
  if (c.source === "transcription") return "Transcript";
  if (c.source === "plaud") return "Plaud";
  return "Manual";
}

function rowHTML(c) {
  const type = safeType(c);
  return `
    <tr data-id="${c.id}">
      <td>
        <div class="name-cell">
          <span class="avatar-circle">${esc(initials(c.name))}</span>
          <span class="nm">${esc(c.name || "—")}</span>
        </div>
      </td>
      <td>${c.company ? esc(c.company) : "—"}</td>
      <td>${c.designation ? esc(c.designation) : "—"}</td>
      <td><span class="type-pill ${type}">${type}</span></td>
      <td>${c.email ? esc(c.email) : "—"}</td>
      <td>${c.phone ? esc(c.phone) : "—"}</td>
      <td><span class="source-pill">${esc(sourceLabel(c))}</span></td>
    </tr>
  `;
}

function openModal(id) {
  editingId = id;
  const c = id == null ? { contact_type: "lead" } : allContacts.find((x) => x.id === id);
  if (!c) return;
  $("m-title").textContent = id == null ? "Add contact" : `Edit · ${c.name || "Contact"}`;
  $("m-name").value = c.name || "";
  $("m-designation").value = c.designation || "";
  $("m-email").value = c.email || "";
  $("m-phone").value = c.phone || "";
  $("m-website").value = c.website || "";
  $("m-linkedin").value = c.linkedin_url || "";
  $("m-company").value = c.company || "";
  const compLink = $("m-company-link");
  if (compLink) {
    if (c.company_id) {
      compLink.href = `/companies?company_id=${c.company_id}`;
      compLink.classList.remove("hidden");
    } else {
      compLink.classList.add("hidden");
    }
  }
  window.wireIndustrySelect("m-industry", "m-industry-other", c.industry || "");
  $("m-address").value = c.address || "";
  $("m-type").value = c.contact_type || "lead";
  $("m-gst").value = c.gst_number || "";
  $("m-notes").value = c.notes || "";
  const sumSec = $("m-summary-section");
  if (c.person_summary && c.person_summary.trim()) {
    $("m-summary").textContent = c.person_summary;
    sumSec.style.display = "";
  } else {
    sumSec.style.display = "none";
  }
  $("m-raw").textContent = c.scan_raw_text || (c.scan_metadata ? JSON.stringify(c.scan_metadata, null, 2) : "—");
  $("m-delete").style.display = id == null ? "none" : "";
  // Research only makes sense for an already-saved contact (it enriches by id).
  const rbtn = $("m-research");
  rbtn.style.display = id == null ? "none" : "";
  rbtn.disabled = false;
  const rstatus = $("m-research-status");
  rstatus.textContent = "";
  rstatus.className = "m-research-status";
  loadContactConversations(id);
  $("modal").classList.add("open");
  setTimeout(() => $("m-name").focus(), 50);
}

// Run AI research (LinkedIn + company/person enrichment) for the open contact.
// Reuses the scan research endpoint, which persists the results server-side and
// returns the updated visitor, so we merge that back into the form + list.
async function runContactResearch() {
  const id = editingId;
  if (id == null) return;
  const btn = $("m-research");
  const status = $("m-research-status");
  btn.disabled = true;
  status.className = "m-research-status busy";
  status.textContent = "Researching the web…";
  try {
    const r = await fetch(`/api/scan/${id}/research`, { method: "POST" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `Research failed (${r.status})`);
    // The user may have switched/closed the modal while research ran.
    if (editingId !== id) return;
    const v = data.visitor || {};
    const idx = allContacts.findIndex((x) => x.id === id);
    if (idx >= 0) allContacts[idx] = { ...allContacts[idx], ...v };
    // Reflect the fields research can change into the open form.
    if (v.company != null) $("m-company").value = v.company || "";
    const compLink = $("m-company-link");
    if (compLink) {
      if (v.company_id) {
        compLink.href = `/companies?company_id=${v.company_id}`;
        compLink.classList.remove("hidden");
      } else {
        compLink.classList.add("hidden");
      }
    }
    if (v.linkedin_url) $("m-linkedin").value = v.linkedin_url;
    if (v.website != null) $("m-website").value = v.website || "";
    if (v.industry != null) window.wireIndustrySelect("m-industry", "m-industry-other", v.industry || "");
    // Summaries: person_summary persists on the contact; the company summary is
    // only in this response, so show it inline now (the company page keeps it).
    const parts = [];
    if (v.person_summary && v.person_summary.trim()) parts.push(v.person_summary.trim());
    if (data.company_summary && data.company_summary.trim()) {
      parts.push("Company — " + data.company_summary.trim());
    }
    if (parts.length) {
      $("m-summary").textContent = parts.join("\n\n");
      $("m-summary-section").style.display = "";
    }
    status.className = "m-research-status " + (data.error ? "warn" : "ok");
    status.textContent = data.error ? `Partial — ${data.error}` : "Researched ✓";
    render();
  } catch (err) {
    // Don't pollute the modal if the user already moved to another contact.
    if (editingId !== id) return;
    status.className = "m-research-status error";
    status.textContent = "Couldn't research";
    showAlert("error", err.message || String(err));
  } finally {
    if (editingId === id) btn.disabled = false;
  }
}

// created_at is naive UTC; append "Z" so the browser shifts it to local time.
function fmtConvoDate(iso) {
  if (!iso) return "—";
  const s = /[zZ]|[+\-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "Z";
  const d = new Date(s);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function convoRowHTML(c) {
  const title = c.topic && c.topic.trim() ? c.topic.trim() : `Conversation #${c.id}`;
  const temp = c.lead_temperature
    ? `<span class="temp ${esc(c.lead_temperature)}">${esc(c.lead_temperature)}</span>` : "";
  const score = c.lead_score != null ? `<span class="muted" style="font-size:12px;">${c.lead_score}/100</span>` : "";
  const company = c.company_name ? `<span class="muted" style="font-size:12px;">${esc(c.company_name)}</span>` : "";
  const snip = c.summary ? `<div class="cv-snip">${esc(c.summary)}</div>` : "";
  const meta = (temp || score || company)
    ? `<div class="cv-meta">${temp}${score}${company}</div>` : "";
  return `<a class="cv-row" href="/conversations?id=${c.id}">
    <div class="cv-top">
      <span class="cv-title">${esc(title)}</span>
      <span class="cv-date">${esc(fmtConvoDate(c.created_at))}</span>
    </div>
    ${snip}
    ${meta}
  </a>`;
}

// Load and render the contact's linked conversations inside the modal. Hidden
// entirely for the "Add contact" (new) flow since there's nothing to show yet.
async function loadContactConversations(id) {
  const sec = $("m-convos-section");
  const box = $("m-convos");
  if (id == null) { sec.style.display = "none"; return; }
  sec.style.display = "";
  box.innerHTML = "<div class='muted' style='font-size:13px;'>Loading…</div>";
  try {
    const r = await fetch(`/api/visitors/${id}/conversations`);
    if (!r.ok) throw new Error(`(${r.status})`);
    const items = await r.json();
    // Guard against a late response after the user switched contacts.
    if (editingId !== id) return;
    if (!items.length) {
      box.innerHTML = "<div class='muted' style='font-size:13px;'>No conversations linked to this contact yet.</div>";
      return;
    }
    box.innerHTML = items.map(convoRowHTML).join("");
  } catch (err) {
    box.innerHTML = `<div class="muted" style="font-size:13px;">Couldn't load conversations ${esc(err.message)}.</div>`;
  }
}

function closeModal() {
  $("modal").classList.remove("open");
  editingId = null;
}

function collectPayload() {
  return {
    name: $("m-name").value.trim(),
    designation: $("m-designation").value.trim() || null,
    email: $("m-email").value.trim() || null,
    phone: $("m-phone").value.trim() || null,
    website: $("m-website").value.trim() || null,
    linkedin_url: $("m-linkedin").value.trim() || null,
    company: $("m-company").value.trim() || null,
    industry: window.readIndustryValue("m-industry", "m-industry-other"),
    address: $("m-address").value.trim() || null,
    contact_type: $("m-type").value || "lead",
    gst_number: $("m-gst").value.trim() || null,
    notes: $("m-notes").value.trim() || null,
  };
}

async function save() {
  const payload = collectPayload();
  if (!payload.name) { showAlert("error", "Name is required."); return; }
  try {
    let r;
    if (editingId == null) {
      r = await fetch("/api/visitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, source: "manual" }),
      });
    } else {
      r = await fetch(`/api/visitors/${editingId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `Save failed (${r.status})`);
    closeModal();
    showAlert("success", editingId == null ? "Contact created." : "Contact updated.");
    await load();
  } catch (err) {
    showAlert("error", err.message || String(err));
  }
}

async function del() {
  if (editingId == null) return;
  if (!confirm("Delete this contact? This also removes any conversations attached to them.")) return;
  try {
    const r = await fetch(`/api/visitors/${editingId}`, { method: "DELETE" });
    if (!r.ok && r.status !== 204) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.detail || `Delete failed (${r.status})`);
    }
    closeModal();
    showAlert("success", "Contact deleted.");
    await load();
  } catch (err) {
    showAlert("error", err.message || String(err));
  }
}
