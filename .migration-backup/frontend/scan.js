// Scan card — camera capture or file upload → POST /api/scan
// → fill the field grid → user reviews → "Save contact" persists / updates.
//
// The backend already writes the Visitor row on POST /api/scan (so a re-scan
// of the same card enriches an existing contact). The "Save" button on this
// page does a PUT to apply any manual corrections the user made in the form.

const $ = (id) => document.getElementById(id);
let currentVisitorId = null;
let stream = null;
let qrScanTimer = null;
let qrDetector = null;
let autoFired = false;  // once we auto-capture, don't fire again for the same stream
let focusCaptureTimer = null;  // pending post-focus auto-capture (see captureAfterFocus)
// QR text decoded in the browser (jsQR / BarcodeDetector). The browser
// decoders read dense vCard QRs reliably, whereas the server's OpenCV decoder
// often truncates them (dropping email/phone/address). So we send what the
// browser read and let the server prefer the richer payload.
let lastQrPayload = null;

document.addEventListener("DOMContentLoaded", () => {
  checkStatus();
  bindCamera();
  bindFile();
  $("btn-save").addEventListener("click", saveEdits);
  $("btn-research").addEventListener("click", runResearch);
  $("btn-reset").addEventListener("click", resetForm);
  $("bulk-research-all").addEventListener("click", researchAllBulk);

  // Pre-fill the company name when arriving from /companies → "+ Scan card".
  // We stash it on the form so the eventual visitor PUT can include it even
  // if the OCR didn't pick a company off the card.
  const params = new URLSearchParams(location.search);
  const prefillCompany = params.get("company");
  if (prefillCompany) {
    $("f-company").value = prefillCompany;
    $("f-company").dataset.prefilled = "1";
  }
  // Populate the industry dropdown up front so it shows options before a scan.
  window.wireIndustrySelect("f-industry", "f-industry-other", "");
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

async function checkStatus() {
  try {
    const r = await fetch("/api/scan/status");
    const j = await r.json();
    const badge = $("scan-status");
    if (j.configured) {
      badge.textContent = "Vision API ready";
      badge.className = "status-badge ok";
    } else {
      badge.textContent = "Vision API not configured";
      badge.className = "status-badge warn";
      showAlert("error", "Google Cloud Vision isn't configured yet. Add the GOOGLE_APPLICATION_CREDENTIALS_JSON secret to enable scanning.");
    }
  } catch {
    $("scan-status").textContent = "—";
  }
}

// ---- Camera --------------------------------------------------------------

function bindCamera() {
  const camBtn = $("btn-camera");
  const capBtn = $("btn-capture");
  const video = $("cam");
  const placeholder = $("preview-placeholder");

  camBtn.addEventListener("click", async () => {
    if (stream) { stopCamera(); return; }
    try {
      // Rear camera on phones; fall back to whatever's available on desktop.
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      video.srcObject = stream;
      video.classList.remove("hidden");
      $("preview-img").classList.add("hidden");
      placeholder.classList.add("hidden");
      camBtn.textContent = "Stop camera";
      capBtn.disabled = false;
      autoFired = false;
      lastQrPayload = null;
      startQrAutoScan();
      showAlert(null);
    } catch (err) {
      showAlert("error", "Couldn't open the camera: " + (err?.message || err));
    }
  });

  capBtn.addEventListener("click", () => {
    if (!stream) return;
    const v = $("cam");
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d").drawImage(v, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const file = new File([blob], `capture_${Date.now()}.jpg`, { type: "image/jpeg" });
      showLocalPreview(file);
      stopCamera();
      uploadAndScan(file);
    }, "image/jpeg", 0.92);
  });
}

function stopCamera() {
  stopQrAutoScan();
  clearTimeout(focusCaptureTimer);
  focusCaptureTimer = null;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  $("cam").classList.add("hidden");
  $("btn-camera").textContent = "Start camera";
  $("btn-capture").disabled = true;
}

// ---- Auto-capture on QR detection ---------------------------------------
// Uses the browser's built-in BarcodeDetector API (Chrome / Edge / Android,
// and Safari 17+). When unavailable we just skip auto-scan and the user
// can use the manual Capture button as a fallback.

function startQrAutoScan() {
  // Prefer jsQR (works in every browser including Safari + the Replit
  // preview iframe). Fall back to the browser's BarcodeDetector if jsQR
  // isn't loaded, and silently no-op if neither is available.
  const video = $("cam");
  const scratch = document.createElement("canvas");
  const ctx = scratch.getContext("2d", { willReadFrequently: true });

  const hasJsQR = typeof window.jsQR === "function";
  let nativeDetector = null;
  if (!hasJsQR && "BarcodeDetector" in window) {
    try { nativeDetector = new window.BarcodeDetector({ formats: ["qr_code"] }); }
    catch { nativeDetector = null; }
  }
  if (!hasJsQR && !nativeDetector) {
    console.warn("[scan] No QR decoder available — manual capture only.");
    return;
  }

  qrScanTimer = setInterval(async () => {
    if (!stream || autoFired || video.readyState < 2) return;
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return;
    try {
      if (hasJsQR) {
        // Downscale large frames for speed — jsQR still finds QRs at 640px wide.
        const scale = Math.min(1, 640 / w);
        scratch.width = Math.round(w * scale);
        scratch.height = Math.round(h * scale);
        ctx.drawImage(video, 0, 0, scratch.width, scratch.height);
        const img = ctx.getImageData(0, 0, scratch.width, scratch.height);
        const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
        if (code && code.data) {
          autoFired = true;
          lastQrPayload = code.data;
          console.log("[scan] QR detected via jsQR:", code.data.slice(0, 80));
          captureAfterFocus();
        }
      } else {
        const codes = await nativeDetector.detect(video);
        if (codes && codes.length > 0) {
          autoFired = true;
          lastQrPayload = codes[0].rawValue || null;
          captureAfterFocus();
        }
      }
    } catch (e) {
      // Frame not ready / transient decode failure — try again next tick.
    }
  }, 300);
}

function stopQrAutoScan() {
  if (qrScanTimer) {
    clearInterval(qrScanTimer);
    qrScanTimer = null;
  }
}

// Once a QR is detected the card is in frame, but the very first frame is
// often still mid-autofocus and blurry — which gives Vision a soft image and
// the "wrong details" users report. Wait briefly so the lens settles, then
// grab a sharp frame.
function captureAfterFocus() {
  showAlert("info", "QR code detected — hold steady, capturing…");
  clearTimeout(focusCaptureTimer);
  focusCaptureTimer = setTimeout(() => {
    focusCaptureTimer = null;
    if (stream) autoCaptureAndUpload();
  }, 600);
}

function autoCaptureAndUpload() {
  if (!stream) return;
  const v = $("cam");
  const canvas = document.createElement("canvas");
  canvas.width = v.videoWidth;
  canvas.height = v.videoHeight;
  canvas.getContext("2d").drawImage(v, 0, 0);
  const qr = lastQrPayload;  // captured by the live jsQR/BarcodeDetector loop
  canvas.toBlob((blob) => {
    if (!blob) return;
    const file = new File([blob], `qr_capture_${Date.now()}.jpg`, { type: "image/jpeg" });
    showLocalPreview(file);
    stopCamera();
    uploadAndScan(file, qr);
  }, "image/jpeg", 0.92);
}

// Decode a QR from a chosen/dropped image file in the browser (jsQR), so the
// upload path gets the same reliable full-payload decode the live camera does.
// Returns the decoded string, or null if there's no QR / no decoder.
function decodeQrFromFile(file) {
  return new Promise((resolve) => {
    if (typeof window.jsQR !== "function") return resolve(null);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        // Cap the working size so huge photos stay fast, but keep it large
        // enough (1600px) that dense vCard QRs still decode.
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        const cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.round(img.width * scale));
        cv.height = Math.max(1, Math.round(img.height * scale));
        const c = cv.getContext("2d", { willReadFrequently: true });
        c.drawImage(img, 0, 0, cv.width, cv.height);
        const data = c.getImageData(0, 0, cv.width, cv.height);
        const code = window.jsQR(data.data, data.width, data.height, { inversionAttempts: "attemptBoth" });
        resolve(code && code.data ? code.data : null);
      } catch {
        resolve(null);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// ---- File upload ---------------------------------------------------------

function bindFile() {
  $("file-input").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    showLocalPreview(f);
    uploadAndScan(f);
  });
  const bulk = $("file-input-bulk");
  if (bulk) {
    bulk.addEventListener("change", (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      if (files.length === 1) {
        // A single file works fine through the normal single-card flow.
        showLocalPreview(files[0]);
        uploadAndScan(files[0]);
      } else {
        uploadAndScanBulk(files);
      }
      bulk.value = "";  // allow re-selecting the same files
    });
  }
}

function showLocalPreview(file) {
  const url = URL.createObjectURL(file);
  const img = $("preview-img");
  img.src = url;
  img.classList.remove("hidden");
  $("preview-placeholder").classList.add("hidden");
}

// ---- Upload + parse + populate ------------------------------------------

const MAX_UPLOAD_MB = 25;  // mirrors the server-side limit in routers/scan.py
const MAX_BULK = 20;       // mirrors MAX_BULK in routers/scan.py

async function uploadAndScan(file, qrPayload = null) {
  showAlert(null);

  // Client-side guards so common mistakes give an instant, clear message
  // instead of a confusing network/server error after a long upload.
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
    showAlert("error", `That image is ${(file.size / 1048576).toFixed(1)} MB — please use one under ${MAX_UPLOAD_MB} MB (a normal phone photo is fine).`);
    return;
  }

  // For chosen/dropped files there's no live camera loop, so decode the QR in
  // the browser here. The browser reads dense vCard QRs reliably; the server's
  // OpenCV decoder often truncates them and loses email/phone/address.
  if (!qrPayload) {
    qrPayload = await decodeQrFromFile(file).catch(() => null);
  }

  setBusy(true);
  startProgress();
  try {
    const fd = new FormData();
    fd.append("image", file, file.name || "card.jpg");
    fd.append("contact_type", $("f-type").value || "lead");
    if (qrPayload) fd.append("qr_payload", qrPayload);
    const notes = $("f-notes").value.trim();
    if (notes) fd.append("notes", notes);

    // The Replit preview connection can drop a request occasionally, which
    // surfaces as a `fetch()` rejection ("Failed to fetch") that never reaches
    // the server. Auto-retry those transient network failures a couple of
    // times before giving up so a single blip doesn't lose the capture. We do
    // NOT retry real HTTP responses (4xx/5xx) — those are deliberate.
    let r;
    const maxAttempts = 3;
    for (let attempt = 1; ; attempt++) {
      try {
        r = await fetch("/api/scan", { method: "POST", body: fd });
        break;
      } catch (netErr) {
        if (attempt >= maxAttempts) {
          throw new Error("Couldn't reach the server after several tries. Check your connection (or reload the page) and scan again.");
        }
        showAlert("info", `Connection hiccup — retrying (${attempt}/${maxAttempts - 1})…`);
        await new Promise((res) => setTimeout(res, 800 * attempt));
      }
    }

    const data = await r.json().catch(() => ({}));
    // 503 means either the readiness gate (server still starting) or the
    // scanner being unconfigured. Only the former is worth a "retry" hint;
    // otherwise fall through to the backend's own message.
    if (r.status === 503 && data.error === "starting") {
      throw new Error("The server is still starting up. Wait a few seconds and try again.");
    }
    if (!r.ok) throw new Error(data.detail || `Scan failed (${r.status})`);

    finishProgress(true);
    populateForm(data);
    currentVisitorId = data.visitor.id;
    $("btn-save").disabled = false;
    $("btn-research").disabled = false;
    resetResearchPanel();
    showAlert("success", `Saved as contact #${data.visitor.id}. Review the fields below, run "Research", or click "Save contact" to apply edits.`);
  } catch (err) {
    finishProgress(false);
    showAlert("error", err.message || String(err));
  } finally {
    setBusy(false);
  }
}

// ---- Bulk upload ---------------------------------------------------------

async function uploadAndScanBulk(files) {
  showAlert(null);
  if (files.length > MAX_BULK) {
    showAlert("error", `You selected ${files.length} images — please upload at most ${MAX_BULK} at a time.`);
    return;
  }
  const tooBig = files.find((f) => f.size > MAX_UPLOAD_MB * 1024 * 1024);
  if (tooBig) {
    showAlert("error", `"${tooBig.name}" is over ${MAX_UPLOAD_MB} MB. Remove it and try again (a normal phone photo is fine).`);
    return;
  }

  // Fresh start: clear the single-card review form and any prior batch.
  resetForm();
  $("bulk-results").classList.add("hidden");
  $("bulk-results-list").innerHTML = "";

  setBusy(true);
  startProgress();
  $("scan-progress-label").textContent = `Processing ${files.length} cards…`;
  try {
    const fd = new FormData();
    for (const f of files) fd.append("images", f, f.name || "card.jpg");
    fd.append("contact_type", $("f-type").value || "lead");

    let r;
    const maxAttempts = 3;
    for (let attempt = 1; ; attempt++) {
      try {
        r = await fetch("/api/scan/bulk", { method: "POST", body: fd });
        break;
      } catch (netErr) {
        if (attempt >= maxAttempts) {
          throw new Error("Couldn't reach the server after several tries. Check your connection (or reload the page) and try again.");
        }
        showAlert("info", `Connection hiccup — retrying (${attempt}/${maxAttempts - 1})…`);
        await new Promise((res) => setTimeout(res, 800 * attempt));
      }
    }

    const data = await r.json().catch(() => ({}));
    if (r.status === 503 && data.error === "starting") {
      throw new Error("The server is still starting up. Wait a few seconds and try again.");
    }
    if (!r.ok) throw new Error(data.detail || `Bulk scan failed (${r.status})`);

    finishProgress(true);
    renderBulkResults(data);
    const { ok_count = 0, failed_count = 0 } = data;
    showAlert(
      failed_count ? "info" : "success",
      `Processed ${ok_count + failed_count} cards — ${ok_count} saved` +
        (failed_count ? `, ${failed_count} failed (see below).` : "."),
    );
  } catch (err) {
    finishProgress(false);
    showAlert("error", err.message || String(err));
  } finally {
    setBusy(false);
  }
}

// Tracks the saved contacts in the current batch so "Research all" can iterate
// over them and update each row's status live. Reset on every render.
let bulkRows = [];

function renderBulkResults(data) {
  const wrap = $("bulk-results");
  const list = $("bulk-results-list");
  const summary = $("bulk-results-summary");
  const results = Array.isArray(data.results) ? data.results : [];
  list.innerHTML = "";
  bulkRows = [];
  summary.textContent = `${data.ok_count || 0} saved · ${data.failed_count || 0} failed`;

  for (const item of results) {
    const row = document.createElement("div");
    row.className = "bulk-row " + (item.status === "ok" ? "ok" : "failed");

    const badge = document.createElement("span");
    badge.className = "bulk-badge " + (item.status === "ok" ? "ok" : "failed");
    badge.textContent = item.status === "ok" ? "Saved" : "Failed";

    const main = document.createElement("div");
    main.className = "bulk-main";

    const title = document.createElement("div");
    title.className = "bulk-title";
    const v = item.visitor || {};
    title.textContent = item.status === "ok"
      ? (v.name || "Unnamed contact")
      : item.filename;

    const meta = document.createElement("div");
    meta.className = "bulk-meta";
    if (item.status === "ok") {
      const bits = [v.company, v.email, v.phone].filter(Boolean);
      meta.textContent = bits.length ? bits.join(" · ") : item.filename;
    } else {
      meta.textContent = item.error || "Couldn't read this card.";
    }

    main.appendChild(title);
    main.appendChild(meta);

    row.appendChild(badge);
    row.appendChild(main);

    if (item.status === "ok" && v.id != null) {
      const statusEl = document.createElement("span");
      statusEl.className = "bulk-status";
      row.appendChild(statusEl);
      bulkRows.push({ id: v.id, statusEl, metaEl: meta, researched: false });

      const link = document.createElement("a");
      link.className = "bulk-link";
      link.href = `/contacts?contact_id=${v.id}`;
      link.textContent = "Open";
      row.appendChild(link);
    }

    list.appendChild(row);
  }

  // Only offer "Research all" when there's at least one saved contact to enrich.
  $("bulk-research-all").classList.toggle("hidden", bulkRows.length === 0);
  wrap.classList.remove("hidden");
}

function setBulkStatus(row, cls, text) {
  if (!row.statusEl) return;
  row.statusEl.className = "bulk-status" + (cls ? " " + cls : "");
  row.statusEl.textContent = text;
}

// Sequentially enrich every saved contact in the batch via the per-contact
// research endpoint (kept out of the upload request so it never times out).
// Stops early and explains when research isn't configured (503).
async function researchAllBulk() {
  const btn = $("bulk-research-all");
  if (!bulkRows.length || btn.disabled) return;
  const label = btn.textContent;
  btn.disabled = true;
  let done = 0, failed = 0, stopped = false;
  for (const row of bulkRows) {
    if (row.researched) { done++; continue; }
    setBulkStatus(row, "busy", "Researching…");
    btn.textContent = `Researching… ${done + failed + 1}/${bulkRows.length}`;
    try {
      const r = await fetch(`/api/scan/${row.id}/research`, { method: "POST" });
      const data = await r.json().catch(() => ({}));
      if (r.status === 503) {
        setBulkStatus(row, "", "");
        showAlert("error", data.detail || "Research is not configured.");
        stopped = true;
        break;
      }
      if (!r.ok) throw new Error(data.detail || `(${r.status})`);
      row.researched = true;
      done++;
      setBulkStatus(row, data.error ? "warn" : "ok", data.error ? "Partial" : "Researched ✓");
      const v = data.visitor || {};
      const bits = [v.company, v.email, v.phone].filter(Boolean);
      if (row.metaEl && bits.length) row.metaEl.textContent = bits.join(" · ");
    } catch (err) {
      failed++;
      setBulkStatus(row, "error", "Failed");
    }
  }
  btn.textContent = label;
  btn.disabled = false;
  if (!stopped) {
    showAlert(failed ? "error" : "success",
      `Research complete — ${done} enriched${failed ? `, ${failed} failed` : ""}.`);
  }
}

// ---- Scan progress bar ---------------------------------------------------
// The long part of a scan is server-side OCR (Google Vision) + the LLM field
// parse, which give no real progress signal. We show a smooth simulated bar
// that creeps through labelled stages and caps at ~92% until the response
// arrives, then snaps to 100%. This is honest enough (the stages map to the
// real pipeline) while reassuring the user that work is happening.
let progressTimer = null;
function startProgress() {
  const wrap = $("scan-progress");
  const bar = $("scan-progress-bar");
  const label = $("scan-progress-label");
  if (!wrap || !bar || !label) return;
  clearInterval(progressTimer);
  let pct = 0;
  bar.style.width = "0%";
  label.textContent = "Uploading image…";
  wrap.classList.remove("hidden");
  wrap.setAttribute("aria-valuenow", "0");
  progressTimer = setInterval(() => {
    let step;
    if (pct < 25) { step = 2.4; label.textContent = "Uploading image…"; }
    else if (pct < 70) { step = 1.1; label.textContent = "Reading text (OCR)…"; }
    else { step = 0.4; label.textContent = "Extracting contact details…"; }
    pct = Math.min(92, pct + step);
    bar.style.width = pct.toFixed(1) + "%";
    wrap.setAttribute("aria-valuenow", String(Math.round(pct)));
  }, 90);
}
function finishProgress(ok) {
  const wrap = $("scan-progress");
  const bar = $("scan-progress-bar");
  const label = $("scan-progress-label");
  clearInterval(progressTimer);
  progressTimer = null;
  if (!wrap || !bar || !label) return;
  if (ok) {
    bar.style.width = "100%";
    wrap.setAttribute("aria-valuenow", "100");
    label.textContent = "Done";
    setTimeout(() => { wrap.classList.add("hidden"); bar.style.width = "0%"; }, 450);
  } else {
    wrap.classList.add("hidden");
    bar.style.width = "0%";
  }
}

function populateForm(data) {
  const v = data.visitor || {};
  const parsed = data.parsed || {};

  // Show the raw OCR for transparency.
  $("raw-text").textContent = (data.raw_text || "").trim() || "—";

  // QR banner — tells the user we got a structured vCard payload, which is
  // higher-confidence than OCR alone.
  const qr = $("qr-banner");
  const qrText = $("qr-banner-text");
  if (data.qr_payload) {
    qr.classList.remove("hidden");
    qrText.textContent = "QR code decoded — fields below were pulled from the embedded vCard/URL.";
  } else {
    qr.classList.add("hidden");
  }

  const map = {
    "f-name": "name",
    "f-designation": "designation",
    "f-company": "company",
    "f-email": "email",
    "f-phone": "phone",
    "f-website": "website",
    "f-linkedin": "linkedin_url",
    "f-gst": "gst_number",
    "f-address": "address",
  };
  for (const [inputId, field] of Object.entries(map)) {
    const el = $(inputId);
    // Show the fresh detection from THIS scan (parsed) first; fall back to the
    // saved visitor record only for fields this scan didn't detect. On a
    // re-scan the visitor row may still hold a stale value the backend won't
    // overwrite, so parsed must win for the review form to be correct.
    if (!parsed[field] && !v[field] && el.dataset.prefilled === "1" && el.value) continue;
    el.value = parsed[field] || v[field] || el.value || "";
  }
  // Industry uses the shared select+other helper.
  window.wireIndustrySelect("f-industry", "f-industry-other", parsed.industry || v.industry || "");
  $("f-type").value = v.contact_type || "lead";
  $("f-notes").value = v.notes || "";

  // "auto" pills mark fields the server detected from OCR/QR, so the user
  // knows what to double-check.
  document.querySelectorAll("[data-pill]").forEach((el) => {
    const f = el.getAttribute("data-pill");
    if (parsed[f]) el.classList.remove("hidden");
    else el.classList.add("hidden");
  });
}

async function saveEdits() {
  if (currentVisitorId == null) return;
  setBusy(true);
  try {
    const payload = {
      name: $("f-name").value.trim() || null,
      designation: $("f-designation").value.trim() || null,
      company: $("f-company").value.trim() || null,
      industry: window.readIndustryValue("f-industry", "f-industry-other"),
      email: $("f-email").value.trim() || null,
      phone: $("f-phone").value.trim() || null,
      website: $("f-website").value.trim() || null,
      linkedin_url: $("f-linkedin").value.trim() || null,
      gst_number: $("f-gst").value.trim() || null,
      address: $("f-address").value.trim() || null,
      contact_type: $("f-type").value || "lead",
      notes: $("f-notes").value.trim() || null,
    };
    // If we arrived from /companies with a specific company_id, force-link
    // the visitor to it (overrides the name-based upsert on the server).
    const params = new URLSearchParams(location.search);
    const cid = params.get("company_id");
    if (cid) payload.company_id = parseInt(cid, 10);

    const r = await fetch(`/api/visitors/${currentVisitorId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `Update failed (${r.status})`);
    const linkedId = data.company_id || cid;
    if (linkedId) {
      showAlert("success", `Saved. Opening company page…`);
      setTimeout(() => { location.href = `/companies?company_id=${linkedId}`; }, 600);
    } else {
      showAlert("success", `Contact #${currentVisitorId} saved. Open it in Contacts to manage it.`);
    }
  } catch (err) {
    showAlert("error", err.message || String(err));
  } finally {
    setBusy(false);
  }
}

function resetForm() {
  currentVisitorId = null;
  ["f-name","f-designation","f-company","f-email","f-phone","f-website","f-linkedin","f-gst","f-address","f-notes"].forEach((id) => { $(id).value = ""; });
  window.wireIndustrySelect("f-industry", "f-industry-other", "");
  $("f-type").value = "lead";
  $("raw-text").textContent = "—";
  $("qr-banner").classList.add("hidden");
  document.querySelectorAll("[data-pill]").forEach((el) => el.classList.add("hidden"));
  $("preview-img").classList.add("hidden");
  $("preview-img").src = "";
  $("preview-placeholder").classList.remove("hidden");
  $("file-input").value = "";
  $("btn-save").disabled = true;
  $("btn-research").disabled = true;
  resetResearchPanel();
  showAlert(null);
}

function setBusy(b) {
  $("btn-save").disabled = b || currentVisitorId == null;
  $("btn-research").disabled = b || currentVisitorId == null;
  $("btn-capture").disabled = b || !stream;
  $("file-input").disabled = b;
  const bulk = $("file-input-bulk");
  if (bulk) bulk.disabled = b;
}

// ---- AI quick research ---------------------------------------------------

function resetResearchPanel() {
  const panel = $("research-panel");
  if (panel) panel.classList.add("hidden");
}

async function runResearch() {
  if (currentVisitorId == null) return;
  const panel = $("research-panel");
  const status = $("research-status");
  const btn = $("btn-research");
  panel.classList.remove("hidden");
  status.textContent = "Researching the web…";
  status.className = "research-status busy";
  btn.disabled = true;
  // Reset bodies to a loading state.
  $("research-company-summary").textContent = "Searching…";
  $("research-person-summary").textContent = "Searching…";
  $("research-competitors").innerHTML = "";
  $("research-sources-block").classList.add("hidden");
  try {
    const r = await fetch(`/api/scan/${currentVisitorId}/research`, { method: "POST" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `Research failed (${r.status})`);
    renderResearch(data);
  } catch (err) {
    status.textContent = "Couldn't fetch research";
    status.className = "research-status error";
    $("research-company-summary").textContent = "—";
    $("research-person-summary").textContent = "—";
    showAlert("error", err.message || String(err));
  } finally {
    btn.disabled = currentVisitorId == null;
  }
}

function renderResearch(data) {
  const status = $("research-status");
  if (data.error) {
    status.textContent = "Partial results — " + data.error;
    status.className = "research-status warn";
  } else {
    status.textContent = "Done";
    status.className = "research-status ok";
  }

  $("research-company-summary").textContent = data.company_summary || "No company summary found.";
  $("research-person-summary").textContent = data.person_summary || "No details found for this person.";

  const chips = $("research-competitors");
  chips.innerHTML = "";
  const comps = Array.isArray(data.competitors) ? data.competitors : [];
  if (comps.length === 0) {
    chips.innerHTML = '<span class="research-empty">None found.</span>';
  } else {
    for (const c of comps) {
      const chip = document.createElement("span");
      chip.className = "research-chip";
      chip.textContent = c.name || "";
      if (c.note) chip.title = c.note;
      chips.appendChild(chip);
    }
  }

  // Reflect a discovered LinkedIn URL back into the editable field if empty.
  if (data.linkedin_url && !$("f-linkedin").value.trim()) {
    $("f-linkedin").value = data.linkedin_url;
    const pill = document.querySelector('[data-pill="linkedin_url"]');
    if (pill) pill.classList.remove("hidden");
  }

  // Correct the company when research confidently identifies the person's
  // current employer — the name read off the card is often stale or wrong.
  if (data.current_company) {
    const cur = $("f-company").value.trim();
    if (cur.toLowerCase() !== data.current_company.toLowerCase()) {
      $("f-company").value = data.current_company;
      const pill = document.querySelector('[data-pill="company"]');
      if (pill) pill.classList.remove("hidden");
    }
  }

  // Industry / website: the server sends a string when it changed the value
  // ("" means it cleared a value that belonged to a corrected company), and
  // null/undefined when it left the field untouched. Mirror that here.
  const togglePill = (name, show) => {
    const pill = document.querySelector(`[data-pill="${name}"]`);
    if (pill) pill.classList.toggle("hidden", !show);
  };
  if (typeof data.industry === "string") {
    window.wireIndustrySelect("f-industry", "f-industry-other", data.industry);
    togglePill("industry", !!data.industry);
  }
  if (typeof data.website === "string") {
    $("f-website").value = data.website;
    togglePill("website", !!data.website);
  }

  const sources = Array.isArray(data.sources) ? data.sources : [];
  const srcBlock = $("research-sources-block");
  const srcEl = $("research-sources");
  if (sources.length) {
    srcEl.innerHTML = "";
    for (const url of sources) {
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      try { a.textContent = new URL(url).hostname.replace(/^www\./, ""); }
      catch { a.textContent = url; }
      srcEl.appendChild(a);
    }
    srcBlock.classList.remove("hidden");
  } else {
    srcBlock.classList.add("hidden");
  }
}
