/* Branding settings page — load + save the org logo/colors/details used to
 * brand Quote agent proposals. Uses the auth.js-patched fetch (Authorization
 * attached automatically). */
(function () {
  "use strict";
  const API = "";

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  let logoDataUrl = null;   // current logo data URI, or null
  let canEdit = true;

  function toast(msg, kind) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast " + (kind || "");
    if (msg) setTimeout(function () { if (t.textContent === msg) { t.textContent = ""; } }, 4000);
  }

  function setLogo(dataUrl) {
    logoDataUrl = dataUrl || null;
    const prev = $("logo-preview");
    const hint = $("logo-hint");
    const rm = $("logo-remove");
    if (logoDataUrl) {
      prev.src = logoDataUrl;
      prev.style.display = "block";
      hint.textContent = "Click to replace";
      rm.style.display = "inline-block";
    } else {
      prev.style.display = "none";
      prev.removeAttribute("src");
      hint.textContent = "Click to upload a PNG or JPG (under ~1 MB)";
      rm.style.display = "none";
    }
    renderPreview();
  }

  function renderPreview() {
    const pcLogo = $("pc-logo");
    if (logoDataUrl) { pcLogo.src = logoDataUrl; pcLogo.style.display = "block"; }
    else { pcLogo.style.display = "none"; pcLogo.removeAttribute("src"); }

    const name = $("company_name").value.trim();
    const bits = ["address", "email", "phone", "website"]
      .map(function (k) { return $(k).value.trim(); })
      .filter(Boolean);
    $("pc-vendor").innerHTML =
      (name ? "<strong>" + esc(name) + "</strong>" : "") +
      bits.map(function (b) { return "<span>" + esc(b) + "</span>"; }).join("");
    const accent = $("accent_color").value.trim() || "#FF5B2E";
    $("pc-accent").style.background = accent;
    const primary = $("primary_color").value.trim() || "#141414";
    $("pc-title").style.color = primary;
  }

  function fill(b) {
    $("company_name").value = b.company_name || "";
    $("address").value = b.address || "";
    $("email").value = b.email || "";
    $("phone").value = b.phone || "";
    $("website").value = b.website || "";
    $("primary_color").value = b.primary_color || "";
    $("accent_color").value = b.accent_color || "";
    $("currency").value = b.currency || "$";
    if (b.primary_color) $("primary_color_pick").value = b.primary_color;
    if (b.accent_color) $("accent_color_pick").value = b.accent_color;
    setLogo(b.logo_data_url || null);
  }

  async function load() {
    try {
      const r = await fetch(API + "/api/branding");
      if (!r.ok) throw new Error("status " + r.status);
      fill(await r.json());
    } catch (e) {
      toast("Couldn't load branding (" + e.message + ")", "err");
    }
  }

  function onLogoFile(file) {
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) {
      toast("Please choose a PNG or JPG image.", "err");
      return;
    }
    if (file.size > 1100 * 1024) {
      toast("That image is too large — please use one under ~1 MB.", "err");
      return;
    }
    const reader = new FileReader();
    reader.onload = function () { setLogo(reader.result); };
    reader.onerror = function () { toast("Couldn't read that file.", "err"); };
    reader.readAsDataURL(file);
  }

  async function save() {
    const btn = $("save-btn");
    btn.disabled = true;
    toast("Saving…");
    const payload = {
      company_name: $("company_name").value.trim(),
      logo_data_url: logoDataUrl || "",
      address: $("address").value.trim(),
      email: $("email").value.trim(),
      phone: $("phone").value.trim(),
      website: $("website").value.trim(),
      primary_color: $("primary_color").value.trim(),
      accent_color: $("accent_color").value.trim(),
      currency: $("currency").value.trim() || "$",
    };
    try {
      const r = await fetch(API + "/api/branding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        let detail = "status " + r.status;
        try { detail = (await r.json()).detail || detail; } catch (e) {}
        throw new Error(detail);
      }
      fill(await r.json());
      toast("Branding saved.", "ok");
    } catch (e) {
      toast(e.message, "err");
    } finally {
      btn.disabled = false;
    }
  }

  function wire() {
    $("logo-drop").addEventListener("click", function () { $("logo-input").click(); });
    $("logo-input").addEventListener("change", function (e) { onLogoFile(e.target.files[0]); });
    $("logo-remove").addEventListener("click", function (e) {
      e.stopPropagation();
      setLogo(null);
    });
    $("save-btn").addEventListener("click", save);

    ["company_name", "address", "email", "phone", "website"].forEach(function (id) {
      $(id).addEventListener("input", renderPreview);
    });
    $("primary_color_pick").addEventListener("input", function (e) {
      $("primary_color").value = e.target.value; renderPreview();
    });
    $("accent_color_pick").addEventListener("input", function (e) {
      $("accent_color").value = e.target.value; renderPreview();
    });
    $("primary_color").addEventListener("input", function (e) {
      if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) $("primary_color_pick").value = e.target.value;
      renderPreview();
    });
    $("accent_color").addEventListener("input", function (e) {
      if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) $("accent_color_pick").value = e.target.value;
      renderPreview();
    });

    load();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
