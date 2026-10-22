const API = "";

// Granular per-step sync toggles: [DOM id, status/settings key].
const GRANULAR_TOGGLES = [
  ["hs-sync-contacts-toggle", "sync_contacts"],
  ["hs-sync-companies-toggle", "sync_companies"],
  ["hs-sync-notes-toggle", "sync_notes"],
  ["hs-sync-transcript-toggle", "sync_transcript"],
  ["hs-sync-tasks-toggle", "sync_tasks"],
  ["hs-sync-insights-toggle", "sync_insights"],
];

function show(id, on) {
  const el = document.getElementById(id);
  if (el) el.style.display = on ? "block" : "none";
}

function showError(msg) {
  const errBox = document.getElementById("hs-error");
  errBox.style.display = "block";
  errBox.textContent = msg;
}

function banner(kind, msg) {
  const b = document.getElementById("hs-banner");
  if (!b) return;
  b.style.display = "block";
  b.textContent = msg;
  if (kind === "success") {
    b.style.background = "rgba(34,197,94,.10)";
    b.style.border = "1px solid rgba(34,197,94,.30)";
    b.style.color = "#16a34a";
  } else {
    b.style.background = "rgba(239,68,68,.08)";
    b.style.border = "1px solid rgba(239,68,68,.25)";
    b.style.color = "#ef4444";
  }
}

function setPill(text, bg, color) {
  const pill = document.getElementById("hs-pill");
  pill.textContent = text;
  pill.style.background = bg;
  pill.style.color = color;
}

function hideAllPanels() {
  ["hs-setup", "hs-connected", "hs-needs-reconnect"].forEach((id) => show(id, false));
}

function applyStatus(data) {
  document.getElementById("hs-error").style.display = "none";
  hideAllPanels();

  if (data.connected) {
    setPill("✓ Connected", "rgba(34,197,94,.15)", "#16a34a");
    document.getElementById("hs-detail").textContent =
      "Concap is talking to your own HubSpot portal. Conversations sync automatically once analyzed.";
    show("hs-connected", true);

    const info = document.getElementById("hs-info");
    const connectedAt = data.connected_at ? new Date(data.connected_at).toLocaleString() : null;
    const rows = [
      ["Portal ID", data.portal_id],
      ["Connected", connectedAt],
    ];
    info.innerHTML = rows
      .filter(([_, v]) => v)
      .map(([k, v]) => `<tr><td class="muted" style="padding:6px 0; width:140px;">${k}</td><td style="padding:6px 0;"><code>${v}</code></td></tr>`)
      .join("");

    const auto = document.getElementById("hs-auto-sync-toggle");
    const deals = document.getElementById("hs-create-deals-toggle");
    auto.checked = !!data.auto_sync;
    deals.checked = !!data.create_deals;
    auto.disabled = false;
    deals.disabled = false;
    show("hs-settings-note", false);

    // Granular per-step toggles (default on when the field is absent).
    GRANULAR_TOGGLES.forEach(([id, key]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.checked = data[key] !== false;
      el.disabled = false;
    });

    // Default-owner picker for synced tasks. Populate the dropdown from the
    // HubSpot owners API, then select the org's configured owner. Failures are
    // non-fatal — the picker just shows "Unassigned".
    loadOwners(data.default_owner_id || "");

    // Last successful sync line.
    const last = document.getElementById("hs-last-sync");
    if (last) {
      if (data.last_sync_at) {
        last.textContent = `Last synced: ${new Date(data.last_sync_at).toLocaleString()}`;
        last.style.display = "block";
      } else {
        last.textContent = "No conversations have synced yet.";
        last.style.display = "block";
      }
    }

    const portalLink = document.getElementById("hs-open-portal");
    const pid = data.portal_id;
    if (pid) {
      portalLink.href = data.portal_url || `https://app.hubspot.com/contacts/${pid}`;
      portalLink.style.display = "inline-block";
    } else {
      portalLink.style.display = "none";
    }
  } else if (data.needs_reconnect) {
    setPill("Reconnect needed", "rgba(234,179,8,.15)", "#b45309");
    document.getElementById("hs-detail").textContent =
      "Your HubSpot connection expired. Reconnect to resume syncing.";
    show("hs-needs-reconnect", true);
  } else {
    // Not connected (or this org disconnected). Nudge them to connect their
    // own portal — there is no shared token to fall back on.
    setPill("Not connected", "rgba(234,179,8,.15)", "#b45309");
    document.getElementById("hs-detail").textContent = data.disconnected
      ? "HubSpot is disconnected for this workspace. Reconnect your own HubSpot portal to resume syncing."
      : "Connect your own HubSpot portal to push every booth conversation into your CRM automatically.";
    show("hs-setup", true);
    const notConfigured = !data.oauth_configured;
    show("hs-not-configured", notConfigured);
    show("hs-nudge", !notConfigured);
    document.getElementById("hs-connect-btn").disabled = notConfigured;
    if (data.reason && data.status_code) {
      showError(`HubSpot replied: ${data.reason} (HTTP ${data.status_code})`);
    }
  }
}

async function loadOwners(selectedId) {
  const select = document.getElementById("hs-owner-select");
  const hint = document.getElementById("hs-owner-hint");
  if (!select) return;
  try {
    const r = await fetch(`${API}/api/hubspot/owners`);
    if (!r.ok) {
      // Keep the "Unassigned" option but reflect the stored selection if any.
      if (selectedId) {
        const opt = document.createElement("option");
        opt.value = selectedId;
        opt.textContent = `Owner ${selectedId} (couldn't load list)`;
        opt.selected = true;
        select.appendChild(opt);
      }
      if (hint) hint.textContent = "Couldn't load HubSpot users right now. Reconnect or try refreshing.";
      return;
    }
    const data = await r.json().catch(() => ({}));
    const owners = Array.isArray(data.owners) ? data.owners : [];
    const current = selectedId || data.default_owner_id || "";
    // Reset to just the unassigned option, then add fetched owners.
    select.innerHTML = '<option value="">Unassigned (HubSpot default)</option>';
    owners.forEach((o) => {
      const opt = document.createElement("option");
      opt.value = o.id;
      opt.textContent = o.email ? `${o.name} (${o.email})` : o.name;
      select.appendChild(opt);
    });
    // If the stored owner isn't in the active list (e.g. deactivated), keep it.
    if (current && !owners.some((o) => String(o.id) === String(current))) {
      const opt = document.createElement("option");
      opt.value = current;
      opt.textContent = `Owner ${current} (inactive)`;
      select.appendChild(opt);
    }
    select.value = current;
    select.dataset.prev = select.value;
    if (hint) {
      hint.textContent = owners.length
        ? "Pick the HubSpot user that follow-up tasks are routed to."
        : "No HubSpot users found in this portal.";
    }
  } catch (e) {
    if (hint) hint.textContent = "Couldn't load HubSpot users right now.";
  }
}

async function loadHubSpotStatus() {
  setPill("Checking…", "var(--panel-2)", "var(--text-muted, #888)");
  try {
    const r = await fetch(`${API}/api/hubspot/status`);
    if (r.status === 401) {
      window.location.href = "/login";
      return;
    }
    applyStatus(await r.json());
  } catch (e) {
    setPill("Error", "rgba(239,68,68,.15)", "#ef4444");
    showError(e.message);
  }
}

async function startOAuth(btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Connecting…";
  try {
    const r = await fetch(`${API}/api/hubspot/oauth/start`);
    if (r.status === 401) {
      window.location.href = "/login";
      return;
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.authorize_url) {
      throw new Error(data.detail || "Could not start the HubSpot connection.");
    }
    window.location.href = data.authorize_url;
  } catch (e) {
    showError(e.message);
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function postAction(path, btn, busyLabel) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyLabel;
  try {
    const r = await fetch(`${API}/api/hubspot/${path}`, { method: "POST" });
    if (r.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (r.status === 403) {
      showError("Only an owner or admin can do that.");
      return;
    }
    applyStatus(await r.json());
  } catch (e) {
    showError(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function saveSetting(patch, inputEl) {
  inputEl.disabled = true;
  try {
    const r = await fetch(`${API}/api/hubspot/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (r.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (r.status === 403) {
      showError("Only an owner or admin can change sync settings.");
      // Revert the toggle to its prior state.
      inputEl.checked = !inputEl.checked;
      return;
    }
    const data = await r.json();
    document.getElementById("hs-auto-sync-toggle").checked = !!data.auto_sync;
    document.getElementById("hs-create-deals-toggle").checked = !!data.create_deals;
    GRANULAR_TOGGLES.forEach(([id, key]) => {
      const el = document.getElementById(id);
      if (el && data[key] !== undefined) el.checked = data[key] !== false;
    });
    document.getElementById("hs-error").style.display = "none";
  } catch (e) {
    showError(e.message);
    inputEl.checked = !inputEl.checked;
  } finally {
    inputEl.disabled = false;
  }
}

document.getElementById("hs-connect-btn").addEventListener("click", (e) => startOAuth(e.currentTarget));
document.getElementById("hs-reconnect-oauth").addEventListener("click", (e) => startOAuth(e.currentTarget));
document.getElementById("hs-refresh").addEventListener("click", () => loadHubSpotStatus());

document.getElementById("hs-auto-sync-toggle").addEventListener("change", (e) =>
  saveSetting({ auto_sync: e.target.checked }, e.target)
);
document.getElementById("hs-create-deals-toggle").addEventListener("change", (e) =>
  saveSetting({ create_deals: e.target.checked }, e.target)
);
GRANULAR_TOGGLES.forEach(([id, key]) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("change", (e) => saveSetting({ [key]: e.target.checked }, e.target));
});

const ownerSelect = document.getElementById("hs-owner-select");
if (ownerSelect) {
  ownerSelect.addEventListener("change", async (e) => {
    const sel = e.currentTarget;
    const prev = sel.dataset.prev || "";
    sel.disabled = true;
    try {
      const r = await fetch(`${API}/api/hubspot/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default_owner_id: sel.value }),
      });
      if (r.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (r.status === 403) {
        showError("Only an owner or admin can change sync settings.");
        sel.value = prev;
        return;
      }
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.detail || "Could not save the owner.");
      sel.value = data.default_owner_id || "";
      sel.dataset.prev = sel.value;
      document.getElementById("hs-error").style.display = "none";
    } catch (err) {
      showError(err.message);
      sel.value = prev;
    } finally {
      sel.disabled = false;
    }
  });
}

const syncNowBtn = document.getElementById("hs-sync-now");
if (syncNowBtn) {
  syncNowBtn.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Syncing…";
    document.getElementById("hs-error").style.display = "none";
    try {
      const r = await fetch(`${API}/api/hubspot/sync-all`, { method: "POST" });
      if (r.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (r.status === 403) {
        showError("Only an owner or admin can run a sync.");
        return;
      }
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.detail || "Sync failed.");
      const synced = data.synced || 0;
      const failed = data.failed || 0;
      if (data.candidates === 0) {
        banner("success", "Everything is already up to date — no conversations needed syncing.");
      } else {
        banner(
          failed ? "error" : "success",
          `Synced ${synced} conversation${synced === 1 ? "" : "s"} to HubSpot${failed ? `, ${failed} failed` : ""}.`
        );
      }
      loadHubSpotStatus();
    } catch (err) {
      showError(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
}

document.getElementById("hs-disconnect").addEventListener("click", (e) => {
  if (!confirm("Disconnect HubSpot? Conversations will stop syncing until you reconnect.")) return;
  postAction("disconnect", e.target, "Disconnecting…");
});

// Show a banner after returning from the OAuth round-trip, then clean the URL.
(function handleRedirect() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("hubspot") === "connected") {
    banner("success", "HubSpot connected. Conversations will now sync to your portal.");
  } else if (params.get("hubspot_error")) {
    banner("error", `HubSpot connection failed: ${params.get("hubspot_error")}`);
  }
  if (params.has("hubspot") || params.has("hubspot_error")) {
    window.history.replaceState({}, "", window.location.pathname);
  }
})();

loadHubSpotStatus();

// ===========================================================================
// Plaud (voice recorder) — per-USER OAuth connection + recording sync.
// Isolated from the HubSpot logic above; uses its own plaud-* element ids.
// ===========================================================================

function plaudShow(id, on) {
  const el = document.getElementById(id);
  if (el) el.style.display = on ? "block" : "none";
}

function plaudError(msg) {
  const el = document.getElementById("plaud-error");
  if (!el) return;
  el.style.display = "block";
  el.textContent = msg;
}

function plaudPill(text, bg, color) {
  const pill = document.getElementById("plaud-pill");
  if (!pill) return;
  pill.textContent = text;
  pill.style.background = bg;
  pill.style.color = color;
}

function plaudHidePanels() {
  ["plaud-setup", "plaud-connected", "plaud-needs-reconnect", "plaud-signin-required"].forEach((id) => plaudShow(id, false));
}

function plaudApplyStatus(data) {
  const err = document.getElementById("plaud-error");
  if (err) err.style.display = "none";
  plaudHidePanels();

  if (data.preview_only) {
    plaudPill("Sign in required", "var(--panel-2)", "var(--text-muted)");
    document.getElementById("plaud-detail").textContent = data.reason;
    plaudShow("plaud-signin-required", true);
    return;
  }

  if (data.connected) {
    plaudPill("✓ Connected", "rgba(34,197,94,.15)", "#16a34a");
    document.getElementById("plaud-detail").textContent =
      "Plaud is connected. Sync to import your recordings as analyzed meetings.";
    plaudShow("plaud-connected", true);

    const info = document.getElementById("plaud-info");
    const connectedAt = data.connected_at ? new Date(data.connected_at).toLocaleString() : null;
    const lastSync = data.last_synced_at ? new Date(data.last_synced_at).toLocaleString() : null;
    const rows = [
      ["Account", data.account_email || data.account_name],
      ["Connected", connectedAt],
      ["Last synced", lastSync],
    ];
    info.replaceChildren();
    rows.filter(([_, value]) => value).forEach(([label, value]) => {
      const row = document.createElement("tr");
      const keyCell = document.createElement("td");
      keyCell.className = "muted";
      keyCell.style.cssText = "padding:6px 0; width:140px;";
      keyCell.textContent = label;
      const valueCell = document.createElement("td");
      valueCell.style.padding = "6px 0";
      const code = document.createElement("code");
      code.textContent = String(value);
      valueCell.appendChild(code);
      row.append(keyCell, valueCell);
      info.appendChild(row);
    });
  } else if (data.needs_reconnect) {
    plaudPill("Reconnect needed", "rgba(234,179,8,.15)", "#b45309");
    document.getElementById("plaud-detail").textContent =
      "Your Plaud connection expired. Reconnect to resume syncing.";
    plaudShow("plaud-needs-reconnect", true);
  } else {
    plaudPill("Not connected", "rgba(234,179,8,.15)", "#b45309");
    document.getElementById("plaud-detail").textContent =
      "Connect your Plaud account to import your voice recordings as analyzed meetings.";
    plaudShow("plaud-setup", true);
    const notConfigured = !data.oauth_configured;
    plaudShow("plaud-not-configured", notConfigured);
    const btn = document.getElementById("plaud-connect-btn");
    if (btn) btn.disabled = notConfigured;
    if (data.reason && notConfigured) plaudError(data.reason);
  }
}

async function loadPlaudStatus() {
  plaudPill("Checking…", "var(--panel-2)", "var(--text-muted, #888)");
  try {
    const r = await fetch(`${API}/api/plaud/status`);
    if (r.status === 401) { window.location.href = "/login"; return; }
    plaudApplyStatus(await r.json());
  } catch (e) {
    plaudPill("Error", "rgba(239,68,68,.15)", "#ef4444");
    plaudError(e.message);
  }
}

async function startPlaudOAuth(btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Connecting…";
  try {
    const r = await fetch(`${API}/api/plaud/oauth/start`);
    if (r.status === 401) { window.location.href = "/login"; return; }
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.authorize_url) {
      throw new Error(data.detail || "Could not start the Plaud connection.");
    }
    window.location.href = data.authorize_url;
  } catch (e) {
    plaudError(e.message);
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function plaudSync(btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Syncing…";
  const result = document.getElementById("plaud-sync-result");
  try {
    const r = await fetch(`${API}/api/plaud/sync`, { method: "POST" });
    if (r.status === 401) { window.location.href = "/login"; return; }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || "Sync failed.");
    if (result) {
      result.style.display = "block";
      const parts = [`Imported ${data.imported}`];
      if (data.skipped_existing) parts.push(`${data.skipped_existing} already imported`);
      if (data.skipped_empty) parts.push(`${data.skipped_empty} empty`);
      if (data.errors) parts.push(`${data.errors} failed`);
      result.textContent = parts.join(" · ") + ` (of ${data.total_seen} recordings).`;
    }
    await loadPlaudStatus();
  } catch (e) {
    plaudError(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function plaudDisconnect(btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Disconnecting…";
  try {
    const r = await fetch(`${API}/api/plaud/disconnect`, { method: "POST" });
    if (r.status === 401) { window.location.href = "/login"; return; }
    await loadPlaudStatus();
  } catch (e) {
    plaudError(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

(function wirePlaud() {
  const signIn = document.getElementById("plaud-sign-in-btn");
  if (signIn) signIn.addEventListener("click", () => window.Auth.logout());
  const connect = document.getElementById("plaud-connect-btn");
  const reconnect = document.getElementById("plaud-reconnect-oauth");
  const sync = document.getElementById("plaud-sync");
  const disconnect = document.getElementById("plaud-disconnect");
  if (connect) connect.addEventListener("click", (e) => startPlaudOAuth(e.currentTarget));
  if (reconnect) reconnect.addEventListener("click", (e) => startPlaudOAuth(e.currentTarget));
  if (sync) sync.addEventListener("click", (e) => plaudSync(e.currentTarget));
  if (disconnect) disconnect.addEventListener("click", (e) => {
    if (!confirm("Disconnect Plaud? You can reconnect any time.")) return;
    plaudDisconnect(e.currentTarget);
  });

  const params = new URLSearchParams(window.location.search);
  if (params.get("plaud") === "connected") {
    banner("success", "Plaud connected. Click Sync recordings to import your meetings.");
  } else if (params.get("plaud_error")) {
    banner("error", `Plaud connection failed: ${params.get("plaud_error")}`);
  }
  if (params.has("plaud") || params.has("plaud_error")) {
    window.history.replaceState({}, "", window.location.pathname);
  }
})();

loadPlaudStatus();

// ===========================================================================
// Salesforce — per-ORG OAuth connection. Mirrors the HubSpot logic above but
// fully isolated with its own sf-* element ids.
// ===========================================================================

function sfShow(id, on) {
  const el = document.getElementById(id);
  if (el) el.style.display = on ? "block" : "none";
}

function sfShowError(msg) {
  const errBox = document.getElementById("sf-error");
  if (!errBox) return;
  errBox.style.display = "block";
  errBox.textContent = msg;
}

function sfBanner(kind, msg) {
  const b = document.getElementById("sf-banner");
  if (!b) return;
  b.style.display = "block";
  b.textContent = msg;
  if (kind === "success") {
    b.style.background = "rgba(34,197,94,.10)";
    b.style.border = "1px solid rgba(34,197,94,.30)";
    b.style.color = "#16a34a";
  } else {
    b.style.background = "rgba(239,68,68,.08)";
    b.style.border = "1px solid rgba(239,68,68,.25)";
    b.style.color = "#ef4444";
  }
}

function sfSetPill(text, bg, color) {
  const pill = document.getElementById("sf-pill");
  if (!pill) return;
  pill.textContent = text;
  pill.style.background = bg;
  pill.style.color = color;
}

function sfHideAllPanels() {
  ["sf-setup", "sf-connected", "sf-needs-reconnect"].forEach((id) => sfShow(id, false));
}

function sfApplyStatus(data) {
  const err = document.getElementById("sf-error");
  if (err) err.style.display = "none";
  sfHideAllPanels();

  if (data.connected) {
    sfSetPill("✓ Connected", "rgba(34,197,94,.15)", "#16a34a");
    document.getElementById("sf-detail").textContent =
      "Concap is talking to your own Salesforce org. Conversations sync automatically once analyzed.";
    sfShow("sf-connected", true);

    const info = document.getElementById("sf-info");
    const connectedAt = data.connected_at ? new Date(data.connected_at).toLocaleString() : null;
    const rows = [
      ["Org ID", data.org_id],
      ["Instance", data.instance_url],
      ["Connected", connectedAt],
    ];
    info.innerHTML = rows
      .filter(([_, v]) => v)
      .map(([k, v]) => `<tr><td class="muted" style="padding:6px 0; width:140px;">${k}</td><td style="padding:6px 0;"><code>${v}</code></td></tr>`)
      .join("");

    const auto = document.getElementById("sf-auto-sync-toggle");
    const opps = document.getElementById("sf-create-opps-toggle");
    auto.checked = !!data.auto_sync;
    opps.checked = !!data.create_opportunities;
    auto.disabled = false;
    opps.disabled = false;
    sfShow("sf-settings-note", false);

    const orgLink = document.getElementById("sf-open-org");
    if (data.instance_url) {
      orgLink.href = data.instance_url;
      orgLink.style.display = "inline-block";
    } else {
      orgLink.style.display = "none";
    }
  } else if (data.needs_reconnect) {
    sfSetPill("Reconnect needed", "rgba(234,179,8,.15)", "#b45309");
    document.getElementById("sf-detail").textContent =
      "Your Salesforce connection expired. Reconnect to resume syncing.";
    sfShow("sf-needs-reconnect", true);
  } else {
    sfSetPill("Not connected", "rgba(234,179,8,.15)", "#b45309");
    document.getElementById("sf-detail").textContent = data.disconnected
      ? "Salesforce is disconnected for this workspace. Reconnect your own Salesforce org to resume syncing."
      : "Connect your own Salesforce org to push every booth conversation into your CRM automatically.";
    sfShow("sf-setup", true);
    const notConfigured = !data.oauth_configured;
    sfShow("sf-not-configured", notConfigured);
    sfShow("sf-nudge", !notConfigured);
    document.getElementById("sf-connect-btn").disabled = notConfigured;
  }
}

async function loadSalesforceStatus() {
  sfSetPill("Checking…", "var(--panel-2)", "var(--text-muted, #888)");
  try {
    const r = await fetch(`${API}/api/salesforce/status`);
    if (r.status === 401) { window.location.href = "/login"; return; }
    sfApplyStatus(await r.json());
  } catch (e) {
    sfSetPill("Error", "rgba(239,68,68,.15)", "#ef4444");
    sfShowError(e.message);
  }
}

async function startSalesforceOAuth(btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Connecting…";
  try {
    const r = await fetch(`${API}/api/salesforce/oauth/start`);
    if (r.status === 401) { window.location.href = "/login"; return; }
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.authorize_url) {
      throw new Error(data.detail || "Could not start the Salesforce connection.");
    }
    window.location.href = data.authorize_url;
  } catch (e) {
    sfShowError(e.message);
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function sfPostAction(path, btn, busyLabel) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyLabel;
  try {
    const r = await fetch(`${API}/api/salesforce/${path}`, { method: "POST" });
    if (r.status === 401) { window.location.href = "/login"; return; }
    if (r.status === 403) { sfShowError("Only an owner or admin can do that."); return; }
    sfApplyStatus(await r.json());
  } catch (e) {
    sfShowError(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function sfSaveSetting(patch, inputEl) {
  inputEl.disabled = true;
  try {
    const r = await fetch(`${API}/api/salesforce/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (r.status === 401) { window.location.href = "/login"; return; }
    if (r.status === 403) {
      sfShowError("Only an owner or admin can change sync settings.");
      inputEl.checked = !inputEl.checked;
      return;
    }
    const data = await r.json();
    document.getElementById("sf-auto-sync-toggle").checked = !!data.auto_sync;
    document.getElementById("sf-create-opps-toggle").checked = !!data.create_opportunities;
    document.getElementById("sf-error").style.display = "none";
  } catch (e) {
    sfShowError(e.message);
    inputEl.checked = !inputEl.checked;
  } finally {
    inputEl.disabled = false;
  }
}

(function wireSalesforce() {
  const connect = document.getElementById("sf-connect-btn");
  const reconnect = document.getElementById("sf-reconnect-oauth");
  const refresh = document.getElementById("sf-refresh");
  const auto = document.getElementById("sf-auto-sync-toggle");
  const opps = document.getElementById("sf-create-opps-toggle");
  const disconnect = document.getElementById("sf-disconnect");
  if (connect) connect.addEventListener("click", (e) => startSalesforceOAuth(e.currentTarget));
  if (reconnect) reconnect.addEventListener("click", (e) => startSalesforceOAuth(e.currentTarget));
  if (refresh) refresh.addEventListener("click", () => loadSalesforceStatus());
  if (auto) auto.addEventListener("change", (e) => sfSaveSetting({ auto_sync: e.target.checked }, e.target));
  if (opps) opps.addEventListener("change", (e) => sfSaveSetting({ create_opportunities: e.target.checked }, e.target));
  if (disconnect) disconnect.addEventListener("click", (e) => {
    if (!confirm("Disconnect Salesforce? Conversations will stop syncing until you reconnect.")) return;
    sfPostAction("disconnect", e.target, "Disconnecting…");
  });

  const params = new URLSearchParams(window.location.search);
  if (params.get("salesforce") === "connected") {
    sfBanner("success", "Salesforce connected. Conversations will now sync to your org.");
  } else if (params.get("salesforce_error")) {
    sfBanner("error", `Salesforce connection failed: ${params.get("salesforce_error")}`);
  }
  if (params.has("salesforce") || params.has("salesforce_error")) {
    window.history.replaceState({}, "", window.location.pathname);
  }
})();

loadSalesforceStatus();
