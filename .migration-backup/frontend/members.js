// Members management. Backend enforces owner/admin; this page just renders.
const $ = (id) => document.getElementById(id);
let me = null;

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function showAlert(kind, msg) {
  $("alert").innerHTML = msg ? `<div class="alert ${kind}">${msg}</div>` : "";
}

async function loadMe() {
  try {
    const r = await fetch("/api/auth/me");
    if (r.ok) me = await r.json();
  } catch {}
  try {
    const o = await fetch("/api/org");
    if (o.ok) {
      const org = await o.json();
      $("org-name").textContent = org.name;
      $("brand-subtitle").textContent = org.name;
    }
  } catch {}
  // Non owner/admin shouldn't be here — backend 403s anyway, but redirect for UX.
  if (me && me.role !== "owner" && me.role !== "admin") {
    window.location.replace("/dashboard");
  }
}

async function loadMembers() {
  const body = $("members-body");
  try {
    const r = await fetch("/api/org/members");
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.detail || `Failed (${r.status})`);
    }
    const members = await r.json();
    body.innerHTML = members
      .map((m) => {
        const isOwner = m.role === "owner";
        const isSelf = me && m.id === me.id;
        const roleCell = isOwner || isSelf
          ? `<span class="pill ${isOwner ? "analyzed" : "created"}">${m.role}</span>`
          : `<select data-role="${m.id}">
               <option value="member" ${m.role === "member" ? "selected" : ""}>member</option>
               <option value="admin" ${m.role === "admin" ? "selected" : ""}>admin</option>
             </select>`;
        const statusCell = m.is_active
          ? `<span class="pill analyzed">active</span>`
          : `<span class="pill error">disabled</span>`;
        const actions = isOwner || isSelf
          ? `<span class="subtle">—</span>`
          : `<button class="small secondary" data-toggle="${m.id}" data-active="${m.is_active}">
               ${m.is_active ? "Disable" : "Enable"}
             </button>`;
        return `<tr>
          <td>${esc(m.email)}${m.must_change_password ? ' <span class="subtle">(pending)</span>' : ""}</td>
          <td>${esc(m.name || "—")}</td>
          <td>${roleCell}</td>
          <td>${statusCell}</td>
          <td>${actions}</td>
        </tr>`;
      })
      .join("");

    body.querySelectorAll("select[data-role]").forEach((sel) => {
      sel.addEventListener("change", () => patchMember(sel.dataset.role, { role: sel.value }));
    });
    body.querySelectorAll("button[data-toggle]").forEach((btn) => {
      btn.addEventListener("click", () =>
        patchMember(btn.dataset.toggle, { is_active: btn.dataset.active !== "true" })
      );
    });
  } catch (e) {
    body.innerHTML = `<tr><td colspan="5" class="muted" style="padding:18px;">${esc(e.message)}</td></tr>`;
  }
}

async function patchMember(id, patch) {
  try {
    const r = await fetch(`/api/org/members/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.detail || `Failed (${r.status})`);
    }
    showAlert(null);
    loadMembers();
  } catch (e) {
    showAlert("error", e.message);
    loadMembers();
  }
}

$("btn-invite").addEventListener("click", async () => {
  const email = $("i-email").value.trim();
  if (!email) { showAlert("error", "Email is required."); return; }
  $("btn-invite").disabled = true;
  try {
    const r = await fetch("/api/org/members", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        name: $("i-name").value.trim() || null,
        role: $("i-role").value,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || `Failed (${r.status})`);
    $("invite-result").innerHTML = `
      <div class="alert success" style="margin-top:14px;">
        Member <strong>${esc(data.member.email)}</strong> created.
        Temporary password: <code>${esc(data.temporary_password)}</code>
        — copy this now, it won't be shown again.
      </div>`;
    $("i-email").value = ""; $("i-name").value = "";
    loadMembers();
  } catch (e) {
    showAlert("error", e.message);
  } finally {
    $("btn-invite").disabled = false;
  }
});

loadMe().then(loadMembers);
