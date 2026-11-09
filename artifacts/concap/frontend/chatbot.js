/* Floating in-app assistant — loaded as a CLASSIC script, injected at the end
 * of appnav.js on every authenticated (sidebar) page, so it never needs to be
 * added to each HTML file by hand.
 *
 * Helps the signed-in user find Conversations, Hot leads, Warm leads, and
 * Sessions. Stays aware of who's asking (Auth.getUser().name) and what page
 * they're on (window.location.pathname) by sending both on every turn to
 * POST /api/chatbot/chat — auth.js's fetch patch attaches the bearer token.
 */
(function () {
  "use strict";

  // Only the authenticated/sidebar pages load appnav.js, but guard anyway —
  // no point rendering a widget for a signed-out visitor.
  if (!window.Auth || !window.Auth.isAuthed || !window.Auth.isAuthed()) return;

  var PAGE_LABELS = {
    "/dashboard": "Dashboard",
    "/conversations": "Conversations",
    "/meetings": "Meetings",
    "/all-meetings": "All Meetings",
    "/imported-meetings": "Imported Meetings",
    "/companies": "Companies",
    "/contacts": "Contacts",
    "/quotes": "Quote agent",
    "/scan": "Scan",
    "/transcribe": "Transcribe",
    "/long-capture": "Long Capture",
    "/booth": "Booth",
    "/admin": "Admin",
    "/members": "Members",
    "/integrations": "Integrations",
    "/branding": "Branding",
    "/brands": "Brands",
    "/profile": "Profile",
    "/privacy": "Privacy",
  };

  function currentPageLabel() {
    var path = window.location.pathname;
    var label = PAGE_LABELS[path] || path;
    return label + " (" + path + ")";
  }

  function firstName(user) {
    var name = (user && (user.display_name || user.name)) || "";
    name = name.trim();
    if (!name) return "there";
    return name.split(" ")[0];
  }

  // --- styles ---------------------------------------------------------
  var STYLE = [
    "#cbw-root { position: fixed; z-index: 2000; right: 20px; bottom: 20px; font-family: var(--sans, inherit); }",
    "#cbw-toggle { width: 52px; height: 52px; border-radius: 50%; border: none; cursor: pointer;",
    "  background: var(--accent-gradient, var(--accent)); color: #fff; box-shadow: 0 6px 18px var(--accent-glow, rgba(0,0,0,.3));",
    "  display: flex; align-items: center; justify-content: center; font-size: 22px; transition: transform .15s; }",
    "#cbw-toggle:hover { transform: scale(1.06); }",
    "#cbw-panel { position: absolute; right: 0; bottom: 64px; width: 340px; max-height: 480px; display: none; flex-direction: column;",
    "  background: var(--surface, #16161A); border: 1px solid var(--border, rgba(255,255,255,.08)); border-radius: var(--radius-lg, 14px);",
    "  box-shadow: 0 16px 40px rgba(0,0,0,.35); overflow: hidden; }",
    "#cbw-panel.open { display: flex; }",
    "#cbw-header { padding: 12px 14px; border-bottom: 1px solid var(--border, rgba(255,255,255,.08)); display: flex; align-items: center; justify-content: space-between; }",
    "#cbw-header strong { font-size: 13px; color: var(--text, #F4F4F0); }",
    "#cbw-header span { font-size: 11px; color: var(--text-muted, rgba(244,244,240,.62)); display: block; margin-top: 1px; }",
    "#cbw-close { background: none; border: none; color: var(--text-muted, rgba(244,244,240,.62)); cursor: pointer; font-size: 16px; line-height: 1; padding: 2px 4px; }",
    "#cbw-close:hover { color: var(--text, #F4F4F0); }",
    "#cbw-messages { flex: 1; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; min-height: 180px; }",
    "#cbw-messages .cbw-msg { max-width: 85%; padding: 8px 11px; border-radius: 10px; font-size: 13px; line-height: 1.4; white-space: pre-wrap; }",
    "#cbw-messages .cbw-msg.user { align-self: flex-end; background: var(--accent-soft, rgba(255,91,46,.12)); color: var(--text, #F4F4F0); }",
    "#cbw-messages .cbw-msg.assistant { align-self: flex-start; background: var(--surface-alt, #1c1c21); color: var(--text, #F4F4F0); border: 1px solid var(--border, rgba(255,255,255,.08)); }",
    "#cbw-messages .cbw-msg.pending { opacity: .6; }",
    "#cbw-messages .cbw-msg.error { border-color: #d14343; color: #ff8a8a; }",
    "#cbw-form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid var(--border, rgba(255,255,255,.08)); }",
    "#cbw-input { flex: 1; background: var(--surface-alt, #1c1c21); border: 1px solid var(--border, rgba(255,255,255,.08));",
    "  border-radius: var(--radius-sm, 8px); color: var(--text, #F4F4F0); font-size: 13px; padding: 8px 10px; font-family: inherit; }",
    "#cbw-input:focus { outline: none; border-color: var(--accent, #FF5B2E); }",
    "#cbw-send { background: var(--accent-gradient, var(--accent)); color: #fff; border: none; border-radius: var(--radius-sm, 8px);",
    "  padding: 0 14px; font-size: 13px; cursor: pointer; }",
    "#cbw-send:disabled { opacity: .5; cursor: default; }",
    "@media (max-width: 480px) { #cbw-panel { width: calc(100vw - 32px); right: -4px; } }",
  ].join("\n");

  function injectStyle() {
    var tag = document.createElement("style");
    tag.id = "cbw-style";
    tag.textContent = STYLE;
    document.head.appendChild(tag);
  }

  function buildDom(name) {
    var root = document.createElement("div");
    root.id = "cbw-root";
    root.innerHTML =
      '<div id="cbw-panel">' +
      '  <div id="cbw-header">' +
      "    <div><strong>Concap Assistant</strong><span>Leads, conversations &amp; sessions</span></div>" +
      '    <button id="cbw-close" type="button" aria-label="Close">&times;</button>' +
      "  </div>" +
      '  <div id="cbw-messages"></div>' +
      '  <form id="cbw-form">' +
      '    <input id="cbw-input" type="text" autocomplete="off" placeholder="Ask about your leads…" />' +
      '    <button id="cbw-send" type="submit">Send</button>' +
      "  </form>" +
      "</div>" +
      '<button id="cbw-toggle" type="button" aria-label="Open assistant">&#128172;</button>';
    document.body.appendChild(root);
    return root;
  }

  function appendMessage(container, role, text, extraClass) {
    var el = document.createElement("div");
    el.className = "cbw-msg " + role + (extraClass ? " " + extraClass : "");
    el.textContent = text;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
    return el;
  }

  function init() {
    var user = window.Auth.getUser();
    injectStyle();
    var root = buildDom(firstName(user));

    var toggle = root.querySelector("#cbw-toggle");
    var panel = root.querySelector("#cbw-panel");
    var closeBtn = root.querySelector("#cbw-close");
    var messages = root.querySelector("#cbw-messages");
    var form = root.querySelector("#cbw-form");
    var input = root.querySelector("#cbw-input");
    var sendBtn = root.querySelector("#cbw-send");

    // Client-side thread so the backend stays stateless. Capped to the last
    // few turns before sending — mirrors chatbot_ai.MAX_HISTORY_MESSAGES.
    var history = [];
    var greeted = false;

    function open() {
      panel.classList.add("open");
      if (!greeted) {
        greeted = true;
        appendMessage(
          messages,
          "assistant",
          "Hi " + firstName(user) + "! Ask me about your Conversations, Hot leads, Warm leads, or Sessions."
        );
      }
      input.focus();
    }

    toggle.addEventListener("click", function () {
      if (panel.classList.contains("open")) {
        panel.classList.remove("open");
      } else {
        open();
      }
    });
    closeBtn.addEventListener("click", function () {
      panel.classList.remove("open");
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text) return;
      input.value = "";
      sendBtn.disabled = true;

      appendMessage(messages, "user", text);
      var pending = appendMessage(messages, "assistant", "Thinking…", "pending");

      fetch("/api/chatbot/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          current_page: currentPageLabel(),
          history: history,
        }),
      })
        .then(function (resp) {
          return resp.json().then(function (data) {
            if (!resp.ok) throw new Error(data.detail || "The assistant hit an error.");
            return data;
          });
        })
        .then(function (data) {
          pending.textContent = data.reply;
          pending.classList.remove("pending");
          history.push({ role: "user", content: text });
          history.push({ role: "assistant", content: data.reply });
          if (history.length > 12) history = history.slice(-12);
        })
        .catch(function (err) {
          pending.textContent = err.message || "Something went wrong — please try again.";
          pending.classList.remove("pending");
          pending.classList.add("error");
        })
        .finally(function () {
          sendBtn.disabled = false;
          input.focus();
        });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
