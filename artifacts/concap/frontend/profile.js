/* Profile page. Shows the signed-in user's account details and their primary
 * voice identification profile. The org-level Consent & Privacy dashboard
 * lives on its own page now — see privacy.html / privacy.js. */
(function () {
  "use strict";

  function setText(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }

  // --- account section ---------------------------------------------------
  function renderAccount() {
    var u = (window.Auth && window.Auth.getUser) ? window.Auth.getUser() : null;
    if (!u) return;
    var name = u.name || (u.email ? u.email.split("@")[0] : "Your account");
    setText("acct-name", name);
    setText("acct-email", u.email || "—");
    setText("acct-role", u.role || "—");
    setText("acct-initial", (name[0] || "@").toUpperCase());
    if (u.organization) {
      setText("acct-org", u.organization.name || "—");
      setText("acct-orgtype", u.organization.org_type || "—");
    }
    if (u.role === "owner" || u.role === "admin") {
      var m = document.getElementById("acct-members");
      if (m) m.style.display = "";
    }
  }

  // --- voice profile section --------------------------------------------
  var vp = {
    mediaRecorder: null, chunks: [], recording: false, busy: false,
    testMode: false, sampleBlob: null, sampleName: null,
    recTimer: null, recSeconds: 0,
  };
  var VP_FIELDS = ["display_name", "job_title", "company_name", "department"];

  function vpEl(id) { return document.getElementById("vp-" + id); }

  function vpRenderStatus(data) {
    var badge = vpEl("status");
    var active = data && data.voice && data.voice.enrolled;
    badge.textContent = active ? "Active" : "Not set up";
    badge.className = "vp-badge" + (active ? " active" : "");
    vpEl("test").style.display = active ? "" : "none";
    vpEl("delete").style.display = active ? "" : "none";
  }

  function vpRender(data) {
    if (!data) return;
    VP_FIELDS.forEach(function (f) {
      var el = vpEl(f);
      if (el && document.activeElement !== el) el.value = data[f] || "";
    });
    var c = vpEl("consent");
    if (c && document.activeElement !== c) c.checked = !!data.consent;
    vpRenderStatus(data);
  }

  function vpLoad() {
    fetch("/api/voice-profile")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) vpRender(d); })
      .catch(function () {});
  }

  function vpSetMsg(id, text, isErr) {
    var el = vpEl(id);
    if (!el) return;
    el.textContent = text || "";
    el.style.color = isErr ? "#ef4444" : "";
  }

  // --- recording animation -------------------------------------------------
  function vpBuildWave() {
    var w = vpEl("wave");
    var time = vpEl("wave-time");
    if (!w || !time) return;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < 36; i++) {
      var b = document.createElement("span");
      b.style.animationDelay = (i * 0.06).toFixed(2) + "s";
      b.style.animationDuration = (0.7 + (i % 5) * 0.12).toFixed(2) + "s";
      frag.appendChild(b);
    }
    w.insertBefore(frag, time);
  }

  function vpFmtTime(sec) {
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function vpWaveOn(on) {
    var w = vpEl("wave");
    if (w) w.classList.toggle("on", !!on);
  }

  function vpStartTimer() {
    vp.recSeconds = 0;
    var t = vpEl("wave-time");
    if (t) t.textContent = "0:00";
    vp.recTimer = setInterval(function () {
      vp.recSeconds += 1;
      var el = vpEl("wave-time");
      if (el) el.textContent = vpFmtTime(vp.recSeconds);
    }, 1000);
  }

  function vpStopTimer() {
    if (vp.recTimer) { clearInterval(vp.recTimer); vp.recTimer = null; }
  }

  // --- sample staging ------------------------------------------------------
  function vpStageSample(blob, name, label) {
    vp.sampleBlob = blob;
    vp.sampleName = name;
    var s = vpEl("sample-state");
    if (s) { s.textContent = label; s.style.color = ""; }
    vpEl("result").style.display = "none";
  }

  function vpFilename(mime) {
    if (mime && mime.indexOf("ogg") >= 0) return "sample.ogg";
    return "sample.webm";
  }

  function vpShowTestResult(j) {
    var box = vpEl("result");
    var pct = Math.round((j.similarity || 0) * 100);
    box.style.display = "";
    box.className = "vp-result " + (j.recognized ? "ok" : "bad");
    box.innerHTML =
      (j.recognized
        ? "<b>Recognized you ✓</b> — your voice profile matched this sample."
        : "<b>Not a confident match.</b> Try a longer, more natural sample.") +
      " Similarity: " + pct + "%" +
      '<div class="vp-meter"><span style="width:' + pct + '%"></span></div>';
  }

  function vpSendTest(blob, filename) {
    if (vp.busy) return;
    vp.busy = true;
    var fd = new FormData();
    fd.append("file", blob, filename);
    vpSetMsg("save-msg", "Testing…");
    vpEl("result").style.display = "none";
    fetch("/api/voice-profile/test", { method: "POST", body: fd })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.detail || "Test failed"); return j; }); })
      .then(function (j) { vp.busy = false; vpSetMsg("save-msg", ""); vpShowTestResult(j); })
      .catch(function (e) { vp.busy = false; vpSetMsg("save-msg", e.message || "Test failed", true); });
  }

  function vpToggleRecord(mode) {
    var btn = vpEl("record");
    if (vp.recording) {
      vp.mediaRecorder && vp.mediaRecorder.stop();
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      vpSetMsg("save-msg", "Recording isn't supported in this browser — upload a file instead.", true);
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (stream) {
        vp.chunks = [];
        var mr = new MediaRecorder(stream);
        vp.mediaRecorder = mr;
        vp.recording = true;
        vp.testMode = mode === "test";
        btn.innerHTML = '<span class="vp-rec-dot"></span>Stop recording';
        vpSetMsg("save-msg", "");
        vpWaveOn(true);
        vpStartTimer();
        mr.ondataavailable = function (e) { if (e.data.size > 0) vp.chunks.push(e.data); };
        mr.onstop = function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          vp.recording = false;
          vpWaveOn(false);
          vpStopTimer();
          btn.innerHTML = "● Record sample";
          var blob = new Blob(vp.chunks, { type: mr.mimeType || "audio/webm" });
          if (vp.testMode) {
            vpSendTest(blob, vpFilename(mr.mimeType));
          } else {
            vpStageSample(
              blob, vpFilename(mr.mimeType),
              "Recording ready (" + vpFmtTime(vp.recSeconds) + "). Accept consent below, then Save voice profile."
            );
          }
        };
        mr.start();
      })
      .catch(function () {
        vpSetMsg("save-msg", "Microphone access was blocked. Allow it, or upload a file instead.", true);
      });
  }

  // --- single save: identity + consent, then staged sample -----------------
  function vpSave() {
    if (vp.busy) return;
    if (vp.recording) { vpSetMsg("save-msg", "Stop the recording first.", true); return; }
    var consent = !!vpEl("consent").checked;
    // Always persist identity + consent. Only attach the staged sample when the
    // user has consented — but a missing-consent sample never blocks the save.
    var willSendSample = !!(vp.sampleBlob && consent);
    vp.busy = true;
    vpSetMsg("save-msg", "Saving…");
    var body = { consent: consent };
    VP_FIELDS.forEach(function (f) { body[f] = vpEl(f).value.trim(); });
    fetch("/api/voice-profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.detail || "Save failed"); return j; }); })
      .then(function (saved) {
        if (willSendSample) {
          vpSetMsg("save-msg", "Building your voice fingerprint…");
          var fd = new FormData();
          fd.append("file", vp.sampleBlob, vp.sampleName || "sample.webm");
          return fetch("/api/voice-profile/sample", { method: "POST", body: fd })
            .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.detail || "Couldn't process the sample."); return j; }); });
        }
        return saved;
      })
      .then(function (d) {
        vp.busy = false;
        if (willSendSample) {
          vp.sampleBlob = null;
          vp.sampleName = null;
          var s = vpEl("sample-state");
          if (s) s.textContent = "";
        }
        vpRender(d);
        if (vp.sampleBlob && !consent) {
          // Identity saved, but the recorded/uploaded sample still needs consent.
          vpSetMsg("save-msg", "Profile saved. Accept consent to add your voice sample.");
        } else {
          vpSetMsg("save-msg", "Saved ✓");
          setTimeout(function () { vpSetMsg("save-msg", ""); }, 2500);
        }
      })
      .catch(function (e) {
        vp.busy = false;
        vpSetMsg("save-msg", e.message || "Save failed", true);
      });
  }

  function vpDelete() {
    if (!window.confirm("Delete your voice profile? Concap AI will stop auto-identifying you until you add a new sample.")) return;
    fetch("/api/voice-profile", { method: "DELETE" })
      .then(function (r) { if (!r.ok) throw new Error("Delete failed"); return r.json(); })
      .then(function (d) { vpRender(d); vpSetMsg("save-msg", "Voice profile deleted."); setTimeout(function () { vpSetMsg("save-msg", ""); }, 3000); })
      .catch(function (e) { vpSetMsg("save-msg", e.message || "Delete failed", true); });
  }

  function vpWire() {
    vpBuildWave();
    vpEl("save").addEventListener("click", vpSave);
    vpEl("record").addEventListener("click", function () { vpToggleRecord("sample"); });
    vpEl("upload-btn").addEventListener("click", function () { vpEl("file").click(); });
    vpEl("file").addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) vpStageSample(f, f.name, "File ready: " + f.name + ". Accept consent below, then Save voice profile.");
      e.target.value = "";
    });
    vpEl("test").addEventListener("click", function () { vpToggleRecord("test"); });
    vpEl("delete").addEventListener("click", vpDelete);
  }

  function init() {
    renderAccount();
    vpWire();
    vpLoad();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
