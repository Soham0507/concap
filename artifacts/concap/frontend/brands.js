/* Brands manager — master/detail editor for the Multi-Brand Quote Agent.
 * Left: list of the org's brands; right: full editor for the selected brand
 * (identity, voice, boilerplate, templates, reference assets, default flag).
 * Uses the auth.js-patched fetch (Authorization attached automatically). */
(function () {
  "use strict";
  const API = "";

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  let brands = [];        // list summaries
  let current = null;     // full detail of the selected brand
  let logoDataUrl = null; // selected brand's logo data URI
  let templates = [];     // editable templates for the selected brand

  function toast(msg, kind) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast " + (kind || "");
    if (msg) setTimeout(function () { if (t.textContent === msg) { t.textContent = ""; } }, 4000);
  }
  function assetToast(msg, kind) {
    const t = $("asset-toast");
    t.textContent = msg;
    t.className = "toast " + (kind || "");
    if (msg) setTimeout(function () { if (t.textContent === msg) { t.textContent = ""; } }, 4000);
  }

  // --- list -------------------------------------------------------------
  function renderList() {
    const wrap = $("brand-list");
    if (!brands.length) {
      wrap.innerHTML = '<div class="muted" style="padding:8px;">No brands yet. Create your first brand.</div>';
      return;
    }
    wrap.innerHTML = brands.map(function (b) {
      const active = current && current.id === b.id ? " active" : "";
      const sw = esc(b.accent_color || b.primary_color || "#FF5B2E");
      return (
        '<div class="brand-list-item' + active + '" data-id="' + b.id + '">' +
        '<span class="brand-swatch" style="background:' + sw + ';"></span>' +
        '<span class="bn"><strong>' + esc(b.name || "Brand") + "</strong>" +
        "<span>" + esc(b.company_name || "") + "</span></span>" +
        (b.is_default ? '<span class="badge-default">Default</span>' : "") +
        "</div>"
      );
    }).join("");
    Array.prototype.forEach.call(wrap.querySelectorAll(".brand-list-item"), function (el) {
      el.addEventListener("click", function () { selectBrand(parseInt(el.dataset.id, 10)); });
    });
  }

  async function loadList(selectId) {
    try {
      const r = await fetch(API + "/api/brands");
      if (!r.ok) throw new Error("status " + r.status);
      brands = await r.json();
      renderList();
      if (selectId != null) {
        selectBrand(selectId);
      } else if (current) {
        const stillExists = brands.some(function (b) { return b.id === current.id; });
        if (!stillExists) { current = null; showEmpty(); }
      }
    } catch (e) {
      toast("Couldn't load brands (" + e.message + ")", "err");
    }
  }

  function showEmpty() {
    $("editor").style.display = "none";
    $("empty-detail").style.display = "block";
    renderList();
  }

  // --- logo -------------------------------------------------------------
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

  // --- templates --------------------------------------------------------
  function renderTemplates() {
    const wrap = $("templates");
    if (!templates.length) {
      wrap.innerHTML = '<div class="muted" style="margin-bottom:10px;">No templates yet.</div>';
      return;
    }
    wrap.innerHTML = templates.map(function (t, i) {
      return (
        '<div class="tmpl" data-i="' + i + '">' +
        '<div class="row2">' +
        '<div class="field" style="margin-bottom:0;"><label>Template name</label>' +
        '<input type="text" class="t-name" value="' + esc(t.name || "") + '" placeholder="Standard proposal" /></div>' +
        '<div class="field" style="margin-bottom:0;"><label>Type (optional)</label>' +
        '<input type="text" class="t-type" value="' + esc(t.template_type || "") + '" placeholder="services / product / retainer" /></div>' +
        "</div>" +
        '<div class="field" style="margin-bottom:8px;"><label>Structure & instructions</label>' +
        '<textarea class="t-instr" placeholder="Describe the sections and structure the AI should follow.">' + esc(t.instructions || "") + "</textarea></div>" +
        '<button class="link-danger t-del">Remove template</button>' +
        "</div>"
      );
    }).join("");
    Array.prototype.forEach.call(wrap.querySelectorAll(".tmpl"), function (el) {
      const i = parseInt(el.dataset.i, 10);
      el.querySelector(".t-name").addEventListener("input", function (e) { templates[i].name = e.target.value; });
      el.querySelector(".t-type").addEventListener("input", function (e) { templates[i].template_type = e.target.value; });
      el.querySelector(".t-instr").addEventListener("input", function (e) { templates[i].instructions = e.target.value; });
      el.querySelector(".t-del").addEventListener("click", function () {
        templates.splice(i, 1);
        renderTemplates();
      });
    });
  }

  // --- assets -----------------------------------------------------------
  function renderAssets() {
    const wrap = $("assets");
    const meta = (current && current.assets_meta) || [];
    if (!meta.length) {
      wrap.innerHTML = '<div class="muted" style="margin-bottom:10px;">No assets uploaded.</div>';
      return;
    }
    wrap.innerHTML = meta.map(function (a, i) {
      return (
        '<div class="asset-item" data-i="' + i + '">' +
        '<span class="pill">' + esc(a.kind || "other") + "</span>" +
        '<span class="ai-name"><strong>' + esc(a.name || "document") + "</strong>" +
        "<span>" + (a.chars || 0) + " chars</span></span>" +
        '<button class="link-danger a-del">Delete</button>' +
        "</div>"
      );
    }).join("");
    Array.prototype.forEach.call(wrap.querySelectorAll(".asset-item"), function (el) {
      const i = parseInt(el.dataset.i, 10);
      el.querySelector(".a-del").addEventListener("click", function () { deleteAsset(i); });
    });
  }

  // --- detail -----------------------------------------------------------
  function fill(b) {
    current = b;
    templates = JSON.parse(JSON.stringify(b.templates || []));
    $("editor").style.display = "block";
    $("empty-detail").style.display = "none";

    $("name").value = b.name === "Brand" ? "" : (b.name || "");
    $("company_name").value = b.company_name || "";
    $("address").value = b.address || "";
    $("email").value = b.email || "";
    $("phone").value = b.phone || "";
    $("website").value = b.website || "";
    $("primary_color").value = b.primary_color || "";
    $("accent_color").value = b.accent_color || "";
    $("currency").value = b.currency || "$";
    $("proposal_theme").value = b.proposal_theme || "";
    $("typography").value = b.typography || "";
    $("business_description").value = b.business_description || "";
    $("brand_voice").value = b.brand_voice || "";
    $("terms").value = b.terms || "";
    $("signature").value = b.signature || "";
    $("footer").value = b.footer || "";
    if (b.primary_color) $("primary_color_pick").value = b.primary_color;
    if (b.accent_color) $("accent_color_pick").value = b.accent_color;
    setLogo(b.logo_data_url || null);

    $("default-flag").style.display = b.is_default ? "inline-block" : "none";
    $("make-default-btn").style.display = b.is_default ? "none" : "inline-block";

    renderTemplates();
    renderAssets();
    renderList();
  }

  async function selectBrand(id) {
    try {
      const r = await fetch(API + "/api/brands/" + id);
      if (!r.ok) throw new Error("status " + r.status);
      fill(await r.json());
    } catch (e) {
      toast("Couldn't load brand (" + e.message + ")", "err");
    }
  }

  function collect() {
    return {
      name: $("name").value.trim(),
      company_name: $("company_name").value.trim(),
      logo_data_url: logoDataUrl || "",
      address: $("address").value.trim(),
      email: $("email").value.trim(),
      phone: $("phone").value.trim(),
      website: $("website").value.trim(),
      primary_color: $("primary_color").value.trim(),
      accent_color: $("accent_color").value.trim(),
      currency: $("currency").value.trim() || "$",
      proposal_theme: $("proposal_theme").value.trim(),
      typography: $("typography").value.trim(),
      business_description: $("business_description").value.trim(),
      brand_voice: $("brand_voice").value.trim(),
      terms: $("terms").value.trim(),
      signature: $("signature").value.trim(),
      footer: $("footer").value.trim(),
      templates: templates,
    };
  }

  async function save() {
    if (!current) return;
    const btn = $("save-btn");
    btn.disabled = true;
    toast("Saving…");
    try {
      const r = await fetch(API + "/api/brands/" + current.id, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collect()),
      });
      if (!r.ok) {
        let detail = "status " + r.status;
        try { detail = (await r.json()).detail || detail; } catch (e) {}
        throw new Error(detail);
      }
      fill(await r.json());
      await loadList();
      toast("Brand saved.", "ok");
    } catch (e) {
      toast(e.message, "err");
    } finally {
      btn.disabled = false;
    }
  }

  async function createBrand() {
    const btn = $("new-brand-btn");
    btn.disabled = true;
    try {
      const r = await fetch(API + "/api/brands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New brand", currency: "$" }),
      });
      if (!r.ok) {
        let detail = "status " + r.status;
        try { detail = (await r.json()).detail || detail; } catch (e) {}
        throw new Error(detail);
      }
      const b = await r.json();
      await loadList(b.id);
    } catch (e) {
      toast(e.message, "err");
    } finally {
      btn.disabled = false;
    }
  }

  async function makeDefault() {
    if (!current) return;
    try {
      const r = await fetch(API + "/api/brands/" + current.id + "/default", { method: "PUT" });
      if (!r.ok) throw new Error("status " + r.status);
      fill(await r.json());
      await loadList();
      toast("Default brand updated.", "ok");
    } catch (e) {
      toast(e.message, "err");
    }
  }

  async function deleteBrand() {
    if (!current) return;
    if (!window.confirm("Delete this brand? Existing proposals keep their saved branding.")) return;
    try {
      const r = await fetch(API + "/api/brands/" + current.id, { method: "DELETE" });
      if (!r.ok && r.status !== 204) throw new Error("status " + r.status);
      current = null;
      showEmpty();
      await loadList();
      toast("Brand deleted.", "ok");
    } catch (e) {
      toast(e.message, "err");
    }
  }

  async function uploadAssets(files) {
    if (!current || !files || !files.length) return;
    const fd = new FormData();
    fd.append("kind", $("asset-kind").value || "other");
    for (let i = 0; i < files.length; i++) fd.append("files", files[i]);
    assetToast("Uploading…");
    try {
      const r = await fetch(API + "/api/brands/" + current.id + "/assets", {
        method: "POST",
        body: fd,
      });
      if (!r.ok) {
        let detail = "status " + r.status;
        try { detail = (await r.json()).detail || detail; } catch (e) {}
        throw new Error(detail);
      }
      current = await r.json();
      renderAssets();
      assetToast("Uploaded.", "ok");
    } catch (e) {
      assetToast(e.message, "err");
    } finally {
      $("asset-input").value = "";
    }
  }

  async function deleteAsset(index) {
    if (!current) return;
    try {
      const r = await fetch(API + "/api/brands/" + current.id + "/assets/" + index, { method: "DELETE" });
      if (!r.ok) throw new Error("status " + r.status);
      current = await r.json();
      renderAssets();
      assetToast("Asset removed.", "ok");
    } catch (e) {
      assetToast(e.message, "err");
    }
  }

  // --- wire -------------------------------------------------------------
  function wire() {
    $("new-brand-btn").addEventListener("click", createBrand);
    $("save-btn").addEventListener("click", save);
    $("make-default-btn").addEventListener("click", makeDefault);
    $("delete-brand-btn").addEventListener("click", deleteBrand);
    $("add-template-btn").addEventListener("click", function () {
      templates.push({ name: "", template_type: "", instructions: "" });
      renderTemplates();
    });

    $("logo-drop").addEventListener("click", function () { $("logo-input").click(); });
    $("logo-input").addEventListener("change", function (e) { onLogoFile(e.target.files[0]); });
    $("logo-remove").addEventListener("click", function (e) { e.stopPropagation(); setLogo(null); });

    $("asset-upload-btn").addEventListener("click", function () { $("asset-input").click(); });
    $("asset-input").addEventListener("change", function (e) { uploadAssets(e.target.files); });

    $("primary_color_pick").addEventListener("input", function (e) { $("primary_color").value = e.target.value; });
    $("accent_color_pick").addEventListener("input", function (e) { $("accent_color").value = e.target.value; });
    $("primary_color").addEventListener("input", function (e) {
      if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) $("primary_color_pick").value = e.target.value;
    });
    $("accent_color").addEventListener("input", function (e) {
      if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) $("accent_color_pick").value = e.target.value;
    });

    loadList();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
