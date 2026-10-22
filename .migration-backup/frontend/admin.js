// Company admin overview. Backend (/api/org/overview) enforces owner/admin
// and scopes everything to the caller's org.
const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}
function showAlert(kind, msg) {
  $("alert").innerHTML = msg ? `<div class="alert ${kind}">${msg}</div>` : "";
}

async function load() {
  try {
    const r = await fetch("/api/org/overview");
    if (r.status === 403) {
      // Members without admin rights shouldn't see this page.
      window.location.replace("/dashboard");
      return;
    }
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.detail || `Failed (${r.status})`);
    }
    const o = await r.json();

    $("org-title").textContent = o.organization.name + " — admin";
    $("org-subtitle").textContent =
      `${o.organization.org_type} workspace · overview of your organization's data`;
    $("org-name").textContent = o.organization.name;
    $("brand-subtitle").textContent = o.organization.name;

    $("s-members").textContent = o.stats.members;
    $("s-visitors").textContent = o.stats.visitors;
    $("s-conversations").textContent = o.stats.conversations;
    $("s-sessions").textContent = o.stats.sessions;
    $("s-hot").textContent = o.stats.hot_leads;
    $("s-warm").textContent = o.stats.warm_leads;

    const mb = $("members-body");
    mb.innerHTML = o.members.length
      ? o.members
          .map(
            (m) => `<tr>
              <td>${esc(m.email)}${m.must_change_password ? ' <span class="subtle">(pending)</span>' : ""}</td>
              <td><span class="pill ${m.role === "owner" ? "analyzed" : "created"}">${esc(m.role)}</span></td>
              <td><span class="pill ${m.is_active ? "analyzed" : "error"}">${m.is_active ? "active" : "disabled"}</span></td>
            </tr>`
          )
          .join("")
      : `<tr><td colspan="3" class="muted" style="padding:16px;">No members.</td></tr>`;

    const rb = $("recent-body");
    rb.innerHTML = o.recent_conversations.length
      ? o.recent_conversations
          .map(
            (c) => `<tr>
              <td><strong>${esc(c.visitor_name)}</strong><div class="muted">${esc(c.visitor_company || "—")}</div></td>
              <td>${c.lead_score != null ? `<strong>${c.lead_score}</strong>` : "—"}${
                c.lead_temperature ? ` <span class="temp ${c.lead_temperature}">${c.lead_temperature}</span>` : ""
              }</td>
              <td><span class="pill ${esc(c.status)}">${esc(c.status)}</span></td>
              <td class="muted">${fmtDate(c.created_at)}</td>
            </tr>`
          )
          .join("")
      : `<tr><td colspan="4" class="muted" style="padding:16px;">No captures yet.</td></tr>`;

    showAlert(null);
  } catch (e) {
    showAlert("error", e.message);
  }
}

$("btn-refresh").addEventListener("click", load);
load();
