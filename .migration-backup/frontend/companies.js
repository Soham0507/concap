// Companies — CRM-style two-pane view, backed by the real /api/companies
// resource. Company is the top-level entity; contacts (people) and
// transcripts (conversations) hang off the selected company on the right.

const $ = (id) => document.getElementById(id);
let companies = [];           // CompanySummary[]
let activeCompany = null;     // CompanyDetail | null
let editingCompanyId = null;
let editingContactId = null;
// Cached transcripts for the "Connect transcript" picker. Loaded once per
// modal-open (fast even with thousands of rows) and filtered client-side.
let pickerConversations = [];

document.addEventListener("DOMContentLoaded", () => {
  loadCompanies();
  $("q").addEventListener("input", renderList);
  $("btn-new-company").addEventListener("click", () => openCompanyModal(null));

  // Company modal wiring
  $("cm-close").addEventListener("click", closeCompanyModal);
  $("cm-cancel").addEventListener("click", closeCompanyModal);
  $("cm-save").addEventListener("click", saveCompany);
  $("cm-delete").addEventListener("click", deleteCompany);
  $("cmodal").addEventListener("click", (e) => { if (e.target === $("cmodal")) closeCompanyModal(); });

  // Contact-person modal wiring
  $("pm-close").addEventListener("click", closeContactModal);
  $("pm-cancel").addEventListener("click", closeContactModal);
  $("pm-save").addEventListener("click", saveContact);
  $("pm-delete").addEventListener("click", deleteContact);
  $("pmodal").addEventListener("click", (e) => { if (e.target === $("pmodal")) closeContactModal(); });

  // Transcript picker modal wiring
  $("tp-close").addEventListener("click", closeTranscriptPicker);
  $("tp-cancel").addEventListener("click", closeTranscriptPicker);
  $("tpmodal").addEventListener("click", (e) => { if (e.target === $("tpmodal")) closeTranscriptPicker(); });
  $("tp-q").addEventListener("input", renderPickerList);
  document.querySelectorAll('input[name="tp-filter"]').forEach((el) => {
    el.addEventListener("change", renderPickerList);
  });

  // Auto-select the company referenced in ?company_id=… (from /scan after a save).
  const params = new URLSearchParams(location.search);
  const cid = params.get("company_id");
  if (cid) setTimeout(() => selectCompany(parseInt(cid, 10)), 200);
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
  if (kind === "success") setTimeout(() => { el.innerHTML = ""; }, 2500);
}
function initials(name) {
  return (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0].toUpperCase()).join("") || "?";
}
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

async function loadCompanies(rememberActive = false) {
  try {
    const r = await fetch("/api/companies");
    if (!r.ok) throw new Error(`Load failed (${r.status})`);
    companies = await r.json();
    renderList();
    if (rememberActive && activeCompany) {
      const still = companies.find(c => c.id === activeCompany.id);
      if (still) await selectCompany(still.id);
      else { activeCompany = null; renderDetail(); }
    }
  } catch (err) {
    showAlert("error", err.message || String(err));
  }
}

function renderList() {
  const q = $("q").value.trim().toLowerCase();
  const list = companies.filter(c => !q
    || c.name.toLowerCase().includes(q)
    || (c.industry || "").toLowerCase().includes(q)
    || (c.city || "").toLowerCase().includes(q));
  const root = $("companies");
  if (list.length === 0) {
    root.innerHTML = `<div style="padding:24px; color:var(--text-muted); text-align:center; font-size:13px;">No companies yet.<br><br><button class="btn-link" onclick="document.getElementById('btn-new-company').click()">+ Add your first company</button></div>`;
    return;
  }
  root.innerHTML = list.map(c => `
    <div class="company-item ${activeCompany?.id === c.id ? "active" : ""}" data-id="${c.id}">
      <div class="name">
        <span>${esc(c.name)}</span>
        <span class="badge">${c.contact_count}</span>
      </div>
      <div class="meta">
        ${c.industry ? `<span>${esc(c.industry)}</span>` : ""}
        ${c.city ? `<span>· ${esc(c.city)}</span>` : ""}
        ${c.conversation_count ? `<span>· 🎙 ${c.conversation_count}</span>` : ""}
      </div>
    </div>
  `).join("");
  root.querySelectorAll(".company-item").forEach(el => {
    el.addEventListener("click", () => selectCompany(parseInt(el.dataset.id, 10)));
  });
}

async function selectCompany(id) {
  try {
    const r = await fetch(`/api/companies/${id}`);
    if (!r.ok) throw new Error(`Couldn't load company (${r.status})`);
    activeCompany = await r.json();
    renderList();
    renderDetail();
  } catch (err) {
    showAlert("error", err.message || String(err));
  }
}

function renderDetail() {
  const root = $("detail");
  if (!activeCompany) {
    root.innerHTML = `<div class="empty">Select a company on the left, or add one to get started.</div>`;
    return;
  }
  const c = activeCompany;
  const websiteHref = c.website
    ? (c.website.startsWith("http") ? c.website : "https://" + c.website)
    : null;
  // Scan flow passes company_id so the server can link the new visitor on save.
  const scanUrl = `/scan?company=${encodeURIComponent(c.name)}&company_id=${c.id}`;

  root.innerHTML = `
    <div class="head">
      <div style="flex:1; min-width:0;">
        <h2>${esc(c.name)}</h2>
        <div class="sub">
          ${c.industry ? esc(c.industry) : ""}
          ${websiteHref ? ` · <a href="${esc(websiteHref)}" target="_blank" rel="noopener">${esc(c.website)}</a>` : ""}
        </div>
        <div class="stats">
          <div class="stat"><div class="n">${c.contact_count}</div><div class="l">Contacts</div></div>
          ${c.employee_count ? `<div class="stat"><div class="n">${c.employee_count}</div><div class="l">Employees</div></div>` : ""}
          ${c.lead_count ? `<div class="stat"><div class="n">${c.lead_count}</div><div class="l">Leads</div></div>` : ""}
          ${c.customer_count ? `<div class="stat"><div class="n">${c.customer_count}</div><div class="l">Customers</div></div>` : ""}
          <div class="stat"><div class="n">${c.conversations.length}</div><div class="l">Transcripts</div></div>
        </div>
      </div>
      <div class="head-actions">
        <button class="btn-secondary" id="btn-edit-company">Edit company</button>
        <a class="btn-primary" href="${scanUrl}">+ Scan card</a>
      </div>
    </div>

    <div class="info-grid">
      ${infoRow("Email", c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : "—")}
      ${infoRow("Phone", c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : "—")}
      ${infoRow("City", c.city || "—")}
      ${infoRow("State", c.state || "—")}
      ${infoRow("Country", c.country || "—")}
      ${infoRow("GST / Tax ID", c.gst_number || "—")}
      ${infoRow("Address", c.address || "—", true)}
      ${infoRow("Referrer", c.referrer || "—", true)}
      ${c.notes ? infoRow("Notes", esc(c.notes).replace(/\n/g, "<br>"), true) : ""}
    </div>

    ${(c.summary || (Array.isArray(c.competitors) && c.competitors.length)) ? `
    <div class="panel">
      <div class="panel-title">
        <h3>AI research</h3>
        ${c.research_updated_at ? `<span class="research-when">Updated ${esc(fmtDate(c.research_updated_at))}</span>` : ""}
      </div>
      <div class="research-block">
        ${c.summary ? `<p class="research-text">${esc(c.summary)}</p>` : ""}
        ${Array.isArray(c.competitors) && c.competitors.length ? `
          <div>
            <div class="comp-label">Competitors</div>
            <div class="comp-chips">${c.competitors.map(compChip).join("")}</div>
          </div>` : ""}
      </div>
    </div>` : ""}

    <div class="panel">
      <div class="panel-title">
        <h3>Contact persons (${c.contacts.length})</h3>
        <button class="btn-link" id="btn-add-contact">+ Add new contact person</button>
      </div>
      <div id="contacts-wrap">
        ${c.contacts.length === 0
          ? `<div style="color:var(--text-muted); font-size:13px; padding:18px 0;">No contacts yet. Add one manually or scan a business card.</div>`
          : c.contacts.map(employeeRow).join("")}
      </div>
    </div>

    <div class="panel">
      <div class="panel-title">
        <h3>Transcripts (${c.conversations.length})</h3>
        <button class="btn-link" id="btn-connect-transcript">+ Connect transcript</button>
      </div>
      <div>
        ${c.conversations.length === 0
          ? `<div style="color:var(--text-muted); font-size:13px; padding:18px 0;">No conversations yet. Record one from the dashboard, or click <strong>+ Connect transcript</strong> to attach an existing one.</div>`
          : c.conversations.map(transcriptRow).join("")}
      </div>
    </div>
  `;

  $("btn-edit-company").addEventListener("click", () => openCompanyModal(c.id));
  $("btn-add-contact").addEventListener("click", () => openContactModal(null));
  $("btn-connect-transcript").addEventListener("click", () => openTranscriptPicker());
  root.querySelectorAll(".employee-row").forEach(el => {
    el.addEventListener("click", () => openContactModal(parseInt(el.dataset.id, 10)));
  });
  // LinkedIn links inside a contact row open in a new tab — don't let the
  // click bubble up and open the edit modal as well.
  root.querySelectorAll(".em-link").forEach(a => {
    a.addEventListener("click", (e) => e.stopPropagation());
  });
  // "Link directly" promotes a via-visitor row to a real Conversation.company_id
  // link so it survives the contact being moved to a different company later.
  root.querySelectorAll("[data-link-conv]").forEach(el => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      linkTranscriptToActiveCompany(parseInt(el.dataset.linkConv, 10));
    });
  });
}

async function linkTranscriptToActiveCompany(conversationId) {
  if (!activeCompany) return;
  try {
    const r = await fetch(`/api/conversations/${conversationId}/company`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company_id: activeCompany.id }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.detail || `Link failed (${r.status})`);
    }
    showAlert("success", "Transcript linked.");
    await selectCompany(activeCompany.id);
  } catch (err) {
    showAlert("error", err.message || String(err));
  }
}

// ---- Transcript picker (manual "(e) Link to company") -------------------
// Opens a modal listing existing transcripts so the user can attach one
// to the active company. Backed by the same PATCH endpoint as the inline
// "Link directly" button, but lets you pick a transcript that wasn't
// already showing up under this company (because it was unlinked, or
// linked to the wrong company).

async function openTranscriptPicker() {
  if (!activeCompany) return;
  $("tp-title").textContent = `Connect transcript to ${activeCompany.name}`;
  $("tp-q").value = "";
  document.querySelector('input[name="tp-filter"][value="unlinked"]').checked = true;
  $("tp-list").innerHTML = `<div style="padding:24px; text-align:center; color:var(--text-muted); font-size:13px;">Loading…</div>`;
  $("tpmodal").classList.add("open");
  try {
    const r = await fetch("/api/conversations");
    if (!r.ok) throw new Error(`Couldn't load transcripts (${r.status})`);
    pickerConversations = await r.json();
    renderPickerList();
  } catch (err) {
    $("tp-list").innerHTML = `<div style="padding:24px; text-align:center; color:var(--danger, #b91c1c); font-size:13px;">${esc(err.message || String(err))}</div>`;
  }
}

function closeTranscriptPicker() {
  $("tpmodal").classList.remove("open");
  pickerConversations = [];
}

function renderPickerList() {
  if (!activeCompany) return;
  const q = $("tp-q").value.trim().toLowerCase();
  const filter = document.querySelector('input[name="tp-filter"]:checked').value;
  // Always exclude transcripts that are already linked to THIS company —
  // they appear in the panel above the modal, no need to surface them.
  let rows = pickerConversations.filter((t) => t.company_id !== activeCompany.id);

  if (filter === "unlinked") {
    rows = rows.filter((t) => t.company_id == null);
  } else if (filter === "other") {
    rows = rows.filter((t) => t.company_id != null);
  } // "all" — no further filter

  if (q) {
    rows = rows.filter((t) =>
      (t.visitor_name || "").toLowerCase().includes(q)
      || (t.visitor_company || "").toLowerCase().includes(q)
      || (t.staff_name || "").toLowerCase().includes(q)
      || (t.company_name || "").toLowerCase().includes(q)
    );
  }

  const list = $("tp-list");
  if (rows.length === 0) {
    list.innerHTML = `<div style="padding:24px; text-align:center; color:var(--text-muted); font-size:13px;">No transcripts match.${filter === "unlinked" ? " Try switching to “Linked to other companies” or “All”." : ""}</div>`;
    return;
  }
  list.innerHTML = rows.map(pickerRow).join("");
  list.querySelectorAll("[data-connect]").forEach((el) => {
    el.addEventListener("click", () => connectFromPicker(parseInt(el.dataset.connect, 10), el.dataset.currentName || null));
  });
}

function pickerRow(t) {
  const temp = t.lead_temperature;
  const suggested = t.suggested_company && t.company_id == null && t.suggested_company.toLowerCase() === (activeCompany?.name || "").toLowerCase();
  // "Suggested" hint when the AI's guess matches THIS company exactly.
  const currentBadge = t.company_id != null
    ? `<span class="pill muted" title="Currently linked to this company.">→ ${esc(t.company_name || "Another company")}</span>`
    : `<span class="pill info">Unlinked</span>`;
  // Clean up the "Transcription: <filename>" placeholder name so the
  // picker doesn't get dominated by ugly filename strings.
  const displayName = (t.visitor_name || "Visitor").replace(/^Transcription:\s*/i, "🎙 ");
  return `
    <div class="tp-row">
      <div style="min-width:0; flex:1;">
        <div class="who">${esc(displayName)}${t.visitor_company ? ` <span style="color:var(--text-muted); font-weight:normal;">· ${esc(t.visitor_company)}</span>` : ""}</div>
        <div class="meta">
          ${t.staff_name ? `<span>${esc(t.staff_name)}</span><span>·</span>` : ""}
          <span>${esc(fmtDate(t.created_at))}</span>
          ${temp ? `<span class="temp-pill ${temp}">${temp}${t.lead_score != null ? " · " + t.lead_score : ""}</span>` : ""}
          ${suggested ? `<span class="pill info" title="The AI suggested this company from the transcript.">✨ AI match</span>` : ""}
        </div>
      </div>
      <div class="right">
        ${currentBadge}
        <button class="btn-primary" style="padding:7px 14px; font-size:12px; font-weight:600;"
                data-connect="${t.id}"
                data-current-name="${esc(t.company_name || "")}">
          ${t.company_id != null ? "Move here" : "Connect"}
        </button>
      </div>
    </div>
  `;
}

async function connectFromPicker(conversationId, currentName) {
  if (!activeCompany) return;
  // If the transcript is currently linked to a different company, make
  // sure the user means to move it — silent re-linking would be a bad
  // surprise on a multi-rep team.
  if (currentName && currentName.trim() && currentName.trim().toLowerCase() !== activeCompany.name.trim().toLowerCase()) {
    if (!confirm(`Move this transcript from "${currentName}" to "${activeCompany.name}"?`)) return;
  }
  try {
    const r = await fetch(`/api/conversations/${conversationId}/company`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company_id: activeCompany.id }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.detail || `Link failed (${r.status})`);
    }
    showAlert("success", "Transcript connected.");
    closeTranscriptPicker();
    await loadCompanies(true); // refresh counts on the left rail too
  } catch (err) {
    showAlert("error", err.message || String(err));
  }
}

function infoRow(label, value, fullWidth = false) {
  return `<div class="row" ${fullWidth ? 'style="grid-column:1/-1;"' : ""}><div class="k">${esc(label)}</div><div class="v">${value || "—"}</div></div>`;
}

function employeeRow(v) {
  const type = v.contact_type || "lead";
  const linkedin = v.linkedin_url
    ? (v.linkedin_url.startsWith("http") ? v.linkedin_url : "https://" + v.linkedin_url)
    : null;
  return `
    <div class="employee-row" data-id="${v.id}">
      <div class="avatar-circle">${esc(initials(v.name))}</div>
      <div class="info">
        <div class="nm">${esc(v.name)}</div>
        <div class="role">${esc(v.designation || "—")}</div>
        ${v.person_summary ? `<div class="em-summary">${esc(v.person_summary)}</div>` : ""}
        ${linkedin ? `<div class="em-links"><a class="em-link" href="${esc(linkedin)}" target="_blank" rel="noopener">LinkedIn ↗</a></div>` : ""}
      </div>
      <div class="contact">
        ${v.email ? `<div>${esc(v.email)}</div>` : ""}
        ${v.phone ? `<div>${esc(v.phone)}</div>` : ""}
      </div>
      <span class="type-pill ${type}">${type}</span>
    </div>
  `;
}

// A single competitor chip. The research service returns objects of the shape
// {name, note}, but tolerate a bare string too. The "note" (why they compete)
// is surfaced as a hover tooltip.
function compChip(x) {
  const name = typeof x === "string" ? x : (x && x.name) || "";
  if (!name) return "";
  const note = (x && typeof x === "object" && x.note) ? x.note : "";
  return `<span class="comp-chip"${note ? ` title="${esc(note)}"` : ""}>${esc(name)}</span>`;
}

function transcriptRow(t) {
  const temp = t.lead_temperature;
  // "via_visitor" rows are shown for context but aren't truly linked to
  // this company — the connection is only through the contact's current
  // company_id. Offer a one-click promote so the link survives if the
  // contact moves accounts later.
  const viaVisitor = t.link_source === "via_visitor";
  const linkBadge = viaVisitor
    ? `<span class="pill info" title="Linked indirectly through the contact, not the transcript itself.">via contact</span>
       <button class="btn-link" data-link-conv="${t.id}" style="margin-left:6px;">Link directly</button>`
    : "";
  return `
    <div class="transcript-row">
      <div class="hdr">
        <span class="who">${esc(t.visitor_name || "Visitor")} ${t.staff_name ? `<span style="color:var(--text-muted); font-weight:normal;">· ${esc(t.staff_name)}</span>` : ""}</span>
        <span class="when">
          ${linkBadge}
          ${temp ? `<span class="temp-pill ${temp}">${temp}${t.lead_score != null ? " · " + t.lead_score : ""}</span> ` : ""}
          ${esc(fmtDate(t.created_at))}
        </span>
      </div>
      <div class="body">${esc(t.transcript || "(processing…)")}</div>
    </div>
  `;
}

// ---- Company modal ------------------------------------------------------

function openCompanyModal(id) {
  editingCompanyId = id;
  let c = {};
  if (id != null && activeCompany?.id === id) c = activeCompany;
  $("cm-title").textContent = id == null ? "Add company" : `Edit · ${c.name || "Company"}`;
  $("cm-name").value = c.name || "";
  window.wireIndustrySelect("cm-industry", "cm-industry-other", c.industry || "");
  $("cm-website").value = c.website || "";
  $("cm-email").value = c.email || "";
  $("cm-phone").value = c.phone || "";
  $("cm-address").value = c.address || "";
  $("cm-city").value = c.city || "";
  $("cm-state").value = c.state || "";
  $("cm-country").value = c.country || "";
  $("cm-gst").value = c.gst_number || "";
  $("cm-referrer").value = c.referrer || "";
  $("cm-notes").value = c.notes || "";
  $("cm-delete").style.display = id == null ? "none" : "";
  $("cmodal").classList.add("open");
  setTimeout(() => $("cm-name").focus(), 50);
}

function closeCompanyModal() { $("cmodal").classList.remove("open"); editingCompanyId = null; }

function companyPayload() {
  return {
    name: $("cm-name").value.trim(),
    industry: window.readIndustryValue("cm-industry", "cm-industry-other"),
    website: $("cm-website").value.trim() || null,
    email: $("cm-email").value.trim() || null,
    phone: $("cm-phone").value.trim() || null,
    address: $("cm-address").value.trim() || null,
    city: $("cm-city").value.trim() || null,
    state: $("cm-state").value.trim() || null,
    country: $("cm-country").value.trim() || null,
    gst_number: $("cm-gst").value.trim() || null,
    referrer: $("cm-referrer").value.trim() || null,
    notes: $("cm-notes").value.trim() || null,
  };
}

async function saveCompany() {
  const payload = companyPayload();
  if (!payload.name) { showAlert("error", "Company name is required."); return; }
  try {
    let r;
    if (editingCompanyId == null) {
      r = await fetch("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      r = await fetch(`/api/companies/${editingCompanyId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `Save failed (${r.status})`);
    const newId = data.id || editingCompanyId;
    closeCompanyModal();
    showAlert("success", editingCompanyId == null ? "Company added." : "Company updated.");
    await loadCompanies();
    if (newId) await selectCompany(newId);
  } catch (err) {
    showAlert("error", err.message || String(err));
  }
}

async function deleteCompany() {
  if (editingCompanyId == null) return;
  if (!confirm("Delete this company? Its contact persons stay in your contacts list (un-linked) and their transcripts are preserved.")) return;
  try {
    const r = await fetch(`/api/companies/${editingCompanyId}`, { method: "DELETE" });
    if (!r.ok && r.status !== 204) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.detail || `Delete failed (${r.status})`);
    }
    closeCompanyModal();
    activeCompany = null;
    showAlert("success", "Company deleted.");
    await loadCompanies();
  } catch (err) {
    showAlert("error", err.message || String(err));
  }
}

// ---- Contact-person modal -----------------------------------------------

function openContactModal(id) {
  if (!activeCompany) return;
  editingContactId = id;
  let v = { contact_type: "lead" };
  if (id != null) {
    const found = activeCompany.contacts.find(x => x.id === id);
    if (found) v = found;
  }
  $("pm-title").textContent = id == null ? `Add contact at ${activeCompany.name}` : `Edit · ${v.name || "Contact"}`;
  $("pm-name").value = v.name || "";
  $("pm-designation").value = v.designation || "";
  $("pm-email").value = v.email || "";
  $("pm-phone").value = v.phone || "";
  $("pm-type").value = v.contact_type || "lead";
  $("pm-notes").value = v.notes || "";
  $("pm-delete").style.display = id == null ? "none" : "";
  $("pmodal").classList.add("open");
  setTimeout(() => $("pm-name").focus(), 50);
}

function closeContactModal() { $("pmodal").classList.remove("open"); editingContactId = null; }

function contactPayload() {
  return {
    name: $("pm-name").value.trim(),
    designation: $("pm-designation").value.trim() || null,
    email: $("pm-email").value.trim() || null,
    phone: $("pm-phone").value.trim() || null,
    contact_type: $("pm-type").value || "lead",
    notes: $("pm-notes").value.trim() || null,
  };
}

async function saveContact() {
  if (!activeCompany) return;
  const payload = contactPayload();
  if (!payload.name) { showAlert("error", "Name is required."); return; }
  try {
    let r;
    if (editingContactId == null) {
      r = await fetch(`/api/companies/${activeCompany.id}/contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, source: "manual" }),
      });
    } else {
      r = await fetch(`/api/visitors/${editingContactId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `Save failed (${r.status})`);
    closeContactModal();
    showAlert("success", editingContactId == null ? "Contact added." : "Contact updated.");
    await loadCompanies(true);
  } catch (err) {
    showAlert("error", err.message || String(err));
  }
}

async function deleteContact() {
  if (editingContactId == null) return;
  if (!confirm("Delete this contact? This also removes any conversations attached to them.")) return;
  try {
    const r = await fetch(`/api/visitors/${editingContactId}`, { method: "DELETE" });
    if (!r.ok && r.status !== 204) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.detail || `Delete failed (${r.status})`);
    }
    closeContactModal();
    showAlert("success", "Contact deleted.");
    await loadCompanies(true);
  } catch (err) {
    showAlert("error", err.message || String(err));
  }
}
