/* Voice Profile setup reminder — shared across authed app pages.
 *
 * Nudges the signed-in user to configure their Primary User Voice Profile when
 * it isn't set up yet, via a one-time popup, a persistent dashboard banner, and
 * a pre-recording interstitial. All three lead to an inline setup wizard that
 * uses the existing /api/voice-profile endpoints. Everything self-heals once the
 * profile is enrolled (reminders stop and stored snooze/dismiss flags clear).
 *
 * Public API (window.VoiceReminder):
 *   - guardRecording(): Promise<boolean>  -> false means "abort, user is configuring"
 *   - openSetup()                          -> opens the wizard directly
 */
(function () {
  "use strict";

  // Only run on authed app pages (auth.js redirects unauthed users away).
  if (!window.Auth || typeof Auth.isAuthed !== "function" || !Auth.isAuthed())
    return;

  var LS_DISMISS = "vp_reminder_dismiss_forever";
  var LS_SNOOZE = "vp_reminder_snooze_until";
  var SS_BANNER = "vp_banner_hidden";
  var SS_REC = "vp_rec_prompted";
  var SNOOZE_MS = 24 * 60 * 60 * 1000; // "Remind me later" = 1 day

  var statusPromise = null;
  var state = {
    wizard: null,
    identity: {},
    sampleBlob: null,
    sampleName: null,
    recorder: null,
    chunks: [],
    recording: false,
    busy: false,
    onClose: null,
  };

  // --- status ---------------------------------------------------------------
  function fetchStatus(force) {
    if (force) statusPromise = null;
    if (!statusPromise) {
      statusPromise = fetch("/api/voice-profile")
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .catch(function () {
          return null;
        });
    }
    return statusPromise;
  }
  function isEnrolled(s) {
    return !!(s && s.voice && s.voice.enrolled);
  }

  function snoozed() {
    if (localStorage.getItem(LS_DISMISS) === "1") return true;
    var until = parseInt(localStorage.getItem(LS_SNOOZE) || "0", 10);
    return until && Date.now() < until;
  }
  function clearReminderFlags() {
    localStorage.removeItem(LS_DISMISS);
    localStorage.removeItem(LS_SNOOZE);
    try {
      sessionStorage.removeItem(SS_BANNER);
    } catch (e) {}
  }

  // --- styles ---------------------------------------------------------------
  function injectStyles() {
    if (document.getElementById("vr-styles")) return;
    var css =
      ".vr-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.55);backdrop-filter:blur(3px);" +
      "display:flex;align-items:center;justify-content:center;z-index:9000;padding:20px;}" +
      ".vr-modal{background:var(--surface,#16161A);border:1px solid var(--border,rgba(255,255,255,.08));" +
      "border-radius:var(--radius-lg,14px);max-width:480px;width:100%;max-height:90vh;overflow:auto;" +
      "box-shadow:0 24px 60px rgba(0,0,0,.5);color:var(--text,#F4F4F0);}" +
      ".vr-modal .vr-inner{padding:26px 26px 22px;}" +
      ".vr-emoji{font-size:30px;}" +
      ".vr-modal h2{margin:10px 0 6px;font-size:21px;}" +
      ".vr-sub{color:var(--text-muted);font-size:14px;line-height:1.5;margin-bottom:14px;}" +
      ".vr-benefits{list-style:none;margin:0 0 18px;padding:0;display:flex;flex-direction:column;gap:8px;}" +
      ".vr-benefits li{font-size:13.5px;display:flex;gap:9px;align-items:flex-start;}" +
      ".vr-benefits li .vr-ck{color:var(--success,#6BD4A1);font-weight:700;flex-shrink:0;}" +
      ".vr-actions{display:flex;flex-direction:column;gap:9px;}" +
      ".vr-actions.row{flex-direction:row;flex-wrap:wrap;}" +
      ".vr-link{background:none;border:none;color:var(--text-muted);font-size:13px;cursor:pointer;" +
      "padding:6px;text-decoration:underline;}" +
      ".vr-link:hover{color:var(--text);}" +
      ".vr-field{margin-bottom:12px;}" +
      ".vr-field label{display:block;font-size:12.5px;color:var(--text-muted);margin-bottom:5px;}" +
      ".vr-field input{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--border);" +
      "border-radius:9px;background:var(--surface-alt,#1c1c21);color:var(--text);font-size:14px;}" +
      ".vr-field input:focus{outline:none;border-color:var(--accent);}" +
      ".vr-consent{display:flex;gap:9px;align-items:flex-start;padding:12px 14px;border:1px solid var(--border);" +
      "border-radius:10px;background:var(--surface-alt);margin:6px 0 14px;font-size:12.5px;color:var(--text-muted);line-height:1.5;}" +
      ".vr-consent input{margin-top:2px;flex-shrink:0;}" +
      ".vr-step-head{font-size:12px;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px;}" +
      ".vr-msg{font-size:13px;margin-top:10px;min-height:18px;}" +
      ".vr-rec-dot{width:9px;height:9px;border-radius:50%;background:#ef4444;display:inline-block;margin-right:7px;" +
      "vertical-align:middle;animation:concapPulse 1.1s ease-in-out infinite;}" +
      ".vr-script{font-style:italic;color:var(--text-muted);font-size:13px;margin:4px 0 12px;padding:10px 13px;" +
      "border-left:3px solid var(--accent);background:var(--surface-alt);border-radius:0 8px 8px 0;}" +
      // dashboard banner
      ".vr-banner{display:flex;gap:14px;align-items:center;padding:14px 16px;margin:0 0 18px;" +
      "border:1px solid var(--accent-soft-text,#ff8a64);background:var(--accent-soft,rgba(255,91,46,.12));" +
      "border-radius:var(--radius,10px);}" +
      ".vr-banner .vr-b-ico{font-size:22px;flex-shrink:0;}" +
      ".vr-banner .vr-b-txt{flex:1;min-width:0;}" +
      ".vr-banner .vr-b-txt b{display:block;font-size:14px;color:var(--text);}" +
      ".vr-banner .vr-b-txt span{font-size:12.5px;color:var(--text-muted);}" +
      ".vr-banner .vr-b-actions{display:flex;gap:8px;align-items:center;flex-shrink:0;}" +
      "@media (max-width:640px){.vr-banner{flex-wrap:wrap;}.vr-banner .vr-b-actions{width:100%;}}";
    var el = document.createElement("style");
    el.id = "vr-styles";
    el.textContent = css;
    document.head.appendChild(el);
  }

  // --- modal plumbing -------------------------------------------------------
  function closeModal() {
    if (state.wizard) {
      try {
        if (state.recorder && state.recording) state.recorder.stop();
      } catch (e) {}
      state.wizard.remove();
      state.wizard = null;
    }
    // Settle any pending caller (e.g. guardRecording) so it never hangs.
    if (state.onClose) {
      var cb = state.onClose;
      state.onClose = null;
      cb();
    }
  }
  function buildModal(innerHTML) {
    injectStyles();
    closeModal();
    var back = document.createElement("div");
    back.className = "vr-backdrop";
    back.innerHTML =
      '<div class="vr-modal" role="dialog" aria-modal="true"><div class="vr-inner">' +
      innerHTML +
      "</div></div>";
    back.addEventListener("click", function (e) {
      if (e.target === back) closeModal();
    });
    document.body.appendChild(back);
    state.wizard = back;
    return back;
  }
  function q(sel) {
    return state.wizard ? state.wizard.querySelector(sel) : null;
  }

  // --- intro popup ----------------------------------------------------------
  function showPopup(onResolve) {
    var html =
      '<div class="vr-emoji">🎤</div>' +
      "<h2>Help Concap AI Recognize You</h2>" +
      '<div class="vr-sub">Set up your Voice Profile to improve conversation analysis and ' +
      "automatically identify you in recordings.</div>" +
      '<ul class="vr-benefits">' +
      '<li><span class="vr-ck">✓</span> Accurate speaker identification</li>' +
      '<li><span class="vr-ck">✓</span> Better AI summaries</li>' +
      '<li><span class="vr-ck">✓</span> Smarter action item assignment</li>' +
      '<li><span class="vr-ck">✓</span> Improved CRM sync</li>' +
      '<li><span class="vr-ck">✓</span> Better Quote Agent proposals</li>' +
      "</ul>" +
      '<div class="vr-actions">' +
      '<button class="btn primary" id="vr-setup">Set Up Voice Profile</button>' +
      '<button class="btn ghost" id="vr-later">Remind Me Later</button>' +
      '<button class="vr-link" id="vr-never">Don\u2019t Show Again</button>' +
      "</div>";
    buildModal(html);
    q("#vr-setup").addEventListener("click", function () {
      openWizard();
    });
    q("#vr-later").addEventListener("click", function () {
      localStorage.setItem(LS_SNOOZE, String(Date.now() + SNOOZE_MS));
      closeModal();
      if (onResolve) onResolve(false);
    });
    q("#vr-never").addEventListener("click", function () {
      localStorage.setItem(LS_DISMISS, "1");
      closeModal();
      if (onResolve) onResolve(false);
    });
  }

  // --- setup wizard ---------------------------------------------------------
  function openWizard() {
    fetchStatus().then(function (s) {
      s = s || {};
      state.identity = {
        display_name: s.display_name || s.name || "",
        job_title: s.job_title || "",
        company_name: s.company_name || "",
      };
      renderStep1();
    });
  }

  function renderStep1() {
    var i = state.identity;
    var html =
      '<div class="vr-step-head">Step 1 of 3 · Your identity</div>' +
      "<h2>Tell us who you are</h2>" +
      '<div class="vr-sub">Concap AI uses this to label you in transcripts instead of \u201CSpeaker 1\u201D.</div>' +
      '<div class="vr-field"><label>Full name</label><input id="vr-name" value="' +
      esc(i.display_name) +
      '" placeholder="Jhon Doe" /></div>' +
      '<div class="vr-field"><label>Job title</label><input id="vr-title" value="' +
      esc(i.job_title) +
      '" placeholder="Consultant" /></div>' +
      '<div class="vr-field"><label>Company name</label><input id="vr-company" value="' +
      esc(i.company_name) +
      '" placeholder="ABC Consulting" /></div>' +
      '<div class="vr-msg" id="vr-msg" style="color:#ef4444;"></div>' +
      '<div class="vr-actions row" style="justify-content:flex-end;margin-top:6px;">' +
      '<button class="btn ghost" id="vr-cancel">Cancel</button>' +
      '<button class="btn primary" id="vr-next">Continue</button>' +
      "</div>";
    buildModal(html);
    q("#vr-cancel").addEventListener("click", closeModal);
    q("#vr-next").addEventListener("click", function () {
      var name = q("#vr-name").value.trim();
      if (!name) {
        q("#vr-msg").textContent = "Please enter your name.";
        return;
      }
      state.identity = {
        display_name: name,
        job_title: q("#vr-title").value.trim(),
        company_name: q("#vr-company").value.trim(),
      };
      renderStep2();
    });
  }

  function renderStep2() {
    var html =
      '<div class="vr-step-head">Step 2 of 3 · Voice sample</div>' +
      "<h2>Add your voice</h2>" +
      '<div class="vr-script">\u201CHello, my name is ' +
      esc(state.identity.display_name) +
      ". I'm recording this short voice sample so that Concap AI can recognize me in future conversations. " +
      "I speak with clients and colleagues every day, and I'd like my transcripts, summaries, and action items " +
      "to be labeled with my name automatically. This recording is only used to build my personal voice " +
      "fingerprint, and the raw audio is never stored.\u201D</div>" +
      '<label class="vr-consent"><input type="checkbox" id="vr-consent" />' +
      "<span><b>I consent to a voice profile.</b> My sample is turned into a numeric voice/style " +
      "fingerprint used only to identify me in my own conversations. The raw recording is not stored, " +
      "and I can delete my profile anytime.</span></label>" +
      '<div class="vr-actions">' +
      '<button class="btn secondary" id="vr-record">\u25CF Record sample</button>' +
      '<button class="btn secondary" id="vr-upload">Upload a file</button>' +
      '<input type="file" id="vr-file" accept="audio/*,.mp3,.wav,.m4a,.aac" style="display:none;" />' +
      "</div>" +
      '<div class="vr-msg" id="vr-msg"></div>' +
      '<div class="vr-actions row" style="justify-content:space-between;margin-top:12px;">' +
      '<button class="btn ghost" id="vr-back">Back</button>' +
      '<button class="btn primary" id="vr-generate" disabled>Generate Voice Profile</button>' +
      "</div>";
    buildModal(html);

    q("#vr-back").addEventListener("click", renderStep1);
    q("#vr-record").addEventListener("click", toggleRecord);
    q("#vr-upload").addEventListener("click", function () {
      q("#vr-file").click();
    });
    q("#vr-file").addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) {
        state.sampleBlob = f;
        state.sampleName = f.name;
        markSampleReady("File ready: " + f.name);
      }
    });
    q("#vr-generate").addEventListener("click", submitProfile);
  }

  function markSampleReady(msg) {
    setMsg(msg, false);
    var gen = q("#vr-generate");
    if (gen) gen.disabled = false;
  }

  function setMsg(text, isErr) {
    var el = q("#vr-msg");
    if (!el) return;
    el.textContent = text || "";
    el.style.color = isErr ? "#ef4444" : "var(--text-muted)";
  }

  function recExt(mime) {
    if (mime && mime.indexOf("ogg") >= 0) return "ogg";
    if (mime && mime.indexOf("mp4") >= 0) return "m4a";
    return "webm";
  }

  function toggleRecord() {
    var btn = q("#vr-record");
    if (state.recording) {
      try {
        state.recorder.stop();
      } catch (e) {}
      return;
    }
    if (
      !navigator.mediaDevices ||
      !navigator.mediaDevices.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setMsg("Recording isn't supported here — upload a file instead.", true);
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then(function (stream) {
        state.chunks = [];
        var mr = new MediaRecorder(stream);
        state.recorder = mr;
        state.recording = true;
        btn.innerHTML = '<span class="vr-rec-dot"></span>Stop recording';
        mr.ondataavailable = function (e) {
          if (e.data && e.data.size > 0) state.chunks.push(e.data);
        };
        mr.onstop = function () {
          stream.getTracks().forEach(function (t) {
            t.stop();
          });
          state.recording = false;
          btn.innerHTML = "\u25CF Re-record sample";
          var blob = new Blob(state.chunks, {
            type: mr.mimeType || "audio/webm",
          });
          state.sampleBlob = blob;
          state.sampleName = "sample." + recExt(mr.mimeType || "");
          markSampleReady("Recording captured \u2713");
        };
        mr.start();
        setMsg("Recording\u2026 read the line above, then press stop.", false);
      })
      .catch(function () {
        setMsg(
          "Microphone access was blocked. Allow it, or upload a file instead.",
          true,
        );
      });
  }

  function submitProfile() {
    if (state.busy) return;
    if (!q("#vr-consent").checked) {
      setMsg("Please accept the consent notice to continue.", true);
      return;
    }
    if (!state.sampleBlob) {
      setMsg("Please record or upload a voice sample first.", true);
      return;
    }
    state.busy = true;
    var gen = q("#vr-generate");
    if (gen) {
      gen.disabled = true;
      gen.textContent = "Generating\u2026";
    }
    setMsg("Saving your details\u2026", false);

    var idBody = {
      display_name: state.identity.display_name,
      job_title: state.identity.job_title,
      company_name: state.identity.company_name,
      consent: true,
    };
    fetch("/api/voice-profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(idBody),
    })
      .then(function (r) {
        if (!r.ok) throw new Error("Couldn't save your profile.");
        return r.json();
      })
      .then(function () {
        setMsg("Building your voice fingerprint\u2026", false);
        var fd = new FormData();
        fd.append("file", state.sampleBlob, state.sampleName || "sample.webm");
        return fetch("/api/voice-profile/sample", { method: "POST", body: fd });
      })
      .then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok)
            throw new Error(j.detail || "Couldn't process the sample.");
          return j;
        });
      })
      .then(function () {
        state.busy = false;
        clearReminderFlags();
        statusPromise = null;
        renderSuccess();
      })
      .catch(function (e) {
        state.busy = false;
        if (gen) {
          gen.disabled = false;
          gen.textContent = "Generate Voice Profile";
        }
        setMsg(e.message || "Something went wrong. Please try again.", true);
      });
  }

  function renderSuccess() {
    var html =
      '<div class="vr-emoji">\u2705</div>' +
      "<h2>Voice Profile Created</h2>" +
      '<div class="vr-sub">Concap AI will now automatically recognize you in future conversations ' +
      "and label you by name across transcripts, summaries, action items, CRM notes and proposals.</div>" +
      '<div class="vr-actions"><button class="btn primary" id="vr-done">Done</button>' +
      '<a class="vr-link" href="/profile" style="text-align:center;">Manage in Settings \u2192 Profile</a></div>';
    buildModal(html);
    q("#vr-done").addEventListener("click", function () {
      closeModal();
      removeBanner();
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }

  // --- dashboard banner -----------------------------------------------------
  function removeBanner() {
    var b = document.getElementById("vr-banner");
    if (b) b.remove();
  }
  function showBanner() {
    try {
      if (sessionStorage.getItem(SS_BANNER) === "1") return;
    } catch (e) {}
    if (document.getElementById("vr-banner")) return;
    var host = document.querySelector(".content-inner");
    if (!host) return;
    injectStyles();
    var div = document.createElement("div");
    div.id = "vr-banner";
    div.className = "vr-banner";
    div.innerHTML =
      '<div class="vr-b-ico">🎤</div>' +
      '<div class="vr-b-txt"><b>Voice Profile not configured</b>' +
      "<span>Concap AI can't currently identify you in conversations.</span></div>" +
      '<div class="vr-b-actions">' +
      '<button class="btn primary" id="vr-b-config">Configure Voice Profile</button>' +
      '<button class="btn ghost" id="vr-b-dismiss">Dismiss</button></div>';
    // Insert just after the page header so it sits at the top of the content.
    var header = host.querySelector(".page-header");
    if (header && header.nextSibling)
      host.insertBefore(div, header.nextSibling);
    else host.insertBefore(div, host.firstChild);
    div.querySelector("#vr-b-config").addEventListener("click", openWizard);
    div.querySelector("#vr-b-dismiss").addEventListener("click", function () {
      try {
        sessionStorage.setItem(SS_BANNER, "1");
      } catch (e) {}
      removeBanner();
    });
  }

  // --- pre-recording interstitial ------------------------------------------
  function guardRecording() {
    return fetchStatus()
      .then(function (s) {
        // Only prompt when we positively know the user is NOT enrolled; a null
        // status (transient API error) is treated as "unknown" -> let them record.
        if (s == null || isEnrolled(s)) return true;
        try {
          if (sessionStorage.getItem(SS_REC) === "1") return true;
        } catch (e) {}
        if (localStorage.getItem(LS_DISMISS) === "1") return true;
        return new Promise(function (resolve) {
          var settled = false;
          function done(v) {
            if (settled) return;
            settled = true;
            resolve(v);
          }
          var html =
            '<div class="vr-emoji">🎤</div>' +
            "<h2>Improve Conversation Accuracy</h2>" +
            '<div class="vr-sub">Create a Voice Profile so Concap AI can automatically recognize ' +
            "your voice and assign action items correctly.</div>" +
            '<div class="vr-actions">' +
            '<button class="btn primary" id="vr-rec-config">Configure Now</button>' +
            '<button class="btn ghost" id="vr-rec-skip">Skip &amp; Continue Recording</button></div>';
          buildModal(html);
          // Any unhandled close (backdrop) = proceed with recording, don't nag again.
          state.onClose = function () {
            try {
              sessionStorage.setItem(SS_REC, "1");
            } catch (e) {}
            done(true);
          };
          q("#vr-rec-config").addEventListener("click", function () {
            state.onClose = null; // transitioning into the wizard, not a plain close
            done(false); // abort this recording start; user is setting up
            openWizard();
          });
          q("#vr-rec-skip").addEventListener("click", function () {
            try {
              sessionStorage.setItem(SS_REC, "1");
            } catch (e) {}
            state.onClose = null;
            closeModal();
            done(true);
          });
        });
      })
      .catch(function () {
        return true;
      });
  }

  // --- auto-init by page ----------------------------------------------------
  function autoInit() {
    var path = (location.pathname || "").replace(/\/+$/, "") || "/";
    fetchStatus().then(function (s) {
      if (isEnrolled(s)) {
        clearReminderFlags();
        return;
      }
      if (path === "/dashboard" || path === "/") {
        showBanner();
        if (!snoozed()) showPopup();
      } else if (
        path === "/conversations" ||
        path === "/imported-meetings" ||
        path === "/meetings"
      ) {
        if (!snoozed()) showPopup();
      }
    });
  }

  window.VoiceReminder = {
    guardRecording: guardRecording,
    openSetup: openWizard,
    refresh: function () {
      return fetchStatus(true);
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoInit);
  } else {
    autoInit();
  }
})();
