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

  // Safety net: the system prompt tells the model to reply in plain text, but
  // strip stray markdown emphasis/heading/backtick markers anyway so a slip
  // (e.g. "**Jane Doe**") never renders as literal asterisks in this
  // plain-text widget.
  function stripMarkdown(text) {
    return String(text)
      .replace(/```([\s\S]*?)```/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/(^|\s)\*([^*\s][^*]*?)\*(?=\s|$)/g, "$1$2")
      .replace(/(^|\s)_([^_\s][^_]*?)_(?=\s|$)/g, "$1$2")
      .replace(/^#{1,6}\s+/gm, "");
  }

  // --- thread persistence -----------------------------------------------
  // Keeps the conversation alive across page navigations (this is a classic
  // multi-page app, so every link click tears down and rebuilds the widget).
  // sessionStorage, not localStorage: it should survive this browser tab's
  // navigation but not linger forever or leak into a different tab/session.
  var STORAGE_KEY = "concap_chatbot_thread_v1";

  function loadThreadState(userEmail) {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var state = JSON.parse(raw);
      // Guard against a stale thread leaking across accounts on a shared
      // machine (e.g. sign out, a different user signs in in the same tab).
      if (!state || state.userEmail !== userEmail) return null;
      return state;
    } catch (e) {
      return null;
    }
  }

  function saveThreadState(state) {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      // Storage disabled/full — the widget still works, it just won't
      // survive navigation.
    }
  }

  function firstName(user) {
    var name = (user && (user.display_name || user.name)) || "";
    name = name.trim();
    if (!name) return "there";
    return name.split(" ")[0];
  }

  function initials(user) {
    var name = (user && (user.display_name || user.name)) || (user && user.email) || "?";
    name = name.trim();
    var parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }

  // --- styles ---------------------------------------------------------
  var STYLE = [
    "#cbw-root { position: fixed; z-index: 2000; right: 20px; bottom: 20px; font-family: var(--sans, inherit); }",

    "#cbw-toggle { width: 56px; height: 56px; border-radius: 50%; border: none; cursor: pointer; position: relative;",
    "  background: var(--accent-gradient, var(--accent)); color: #fff; box-shadow: 0 8px 24px var(--accent-glow, rgba(0,0,0,.35));",
    "  display: flex; align-items: center; justify-content: center; transition: transform .2s cubic-bezier(.34,1.56,.64,1), box-shadow .2s; }",
    "#cbw-toggle:hover { transform: scale(1.08); box-shadow: 0 10px 28px var(--accent-glow, rgba(0,0,0,.4)); }",
    "#cbw-toggle:active { transform: scale(.96); }",
    "#cbw-toggle svg { width: 24px; height: 24px; transition: opacity .15s, transform .15s; }",
    "#cbw-toggle .cbw-icon-close { position: absolute; opacity: 0; transform: rotate(-45deg) scale(.6); }",
    "#cbw-toggle.open .cbw-icon-chat { opacity: 0; transform: rotate(45deg) scale(.6); }",
    "#cbw-toggle.open .cbw-icon-close { opacity: 1; transform: rotate(0) scale(1); }",

    "#cbw-panel { position: absolute; right: 0; bottom: 70px; width: 360px; max-height: 520px; display: flex; flex-direction: column;",
    "  background: var(--surface, #16161A); border: 1px solid var(--border, rgba(255,255,255,.08)); border-radius: var(--radius-lg, 14px);",
    "  box-shadow: 0 20px 48px rgba(0,0,0,.4), 0 2px 8px rgba(0,0,0,.2); overflow: hidden;",
    "  opacity: 0; transform: translateY(16px) scale(.96); pointer-events: none;",
    "  transform-origin: bottom right; transition: opacity .18s ease, transform .22s cubic-bezier(.34,1.56,.64,1); }",
    "#cbw-panel.open { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }",

    "#cbw-header { padding: 14px 16px; position: relative; display: flex; align-items: center; justify-content: space-between;",
    "  background: var(--accent-gradient, var(--accent)); overflow: hidden; }",
    "#cbw-header::after { content: ''; position: absolute; inset: 0; background: radial-gradient(120px 60px at 100% 0%, rgba(255,255,255,.25), transparent 70%); }",
    "#cbw-header-text { position: relative; display: flex; flex-direction: column; }",
    "#cbw-header strong { font-size: 14px; color: #fff; letter-spacing: -.01em; }",
    "#cbw-header span { font-size: 11px; color: rgba(255,255,255,.85); display: flex; align-items: center; gap: 5px; margin-top: 2px; }",
    "#cbw-status-dot { width: 6px; height: 6px; border-radius: 50%; background: #5CE39B; box-shadow: 0 0 0 2px rgba(92,227,155,.25); flex-shrink: 0; }",
    "#cbw-close { position: relative; background: rgba(255,255,255,.14); border: none; color: #fff; cursor: pointer; font-size: 15px; line-height: 1;",
    "  width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; transition: background .15s; }",
    "#cbw-close:hover { background: rgba(255,255,255,.26); }",

    "#cbw-messages { flex: 1; overflow-y: auto; padding: 14px 14px 6px; display: flex; flex-direction: column; gap: 12px; min-height: 220px; }",
    "#cbw-messages::-webkit-scrollbar { width: 6px; }",
    "#cbw-messages::-webkit-scrollbar-thumb { background: var(--border-strong, rgba(255,255,255,.16)); border-radius: 99px; }",

    "#cbw-messages .cbw-row { display: flex; align-items: flex-end; gap: 7px; max-width: 92%; opacity: 0; transform: translateY(6px);",
    "  animation: cbw-in .22s ease forwards; }",
    "#cbw-messages .cbw-row.user { align-self: flex-end; flex-direction: row-reverse; }",
    "#cbw-messages .cbw-row.assistant { align-self: flex-start; }",
    "@keyframes cbw-in { to { opacity: 1; transform: translateY(0); } }",

    "#cbw-messages .cbw-avatar { width: 22px; height: 22px; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center;",
    "  font-size: 9px; font-weight: 600; color: #fff; }",
    "#cbw-messages .cbw-row.assistant .cbw-avatar { background: var(--accent-gradient, var(--accent)); }",
    "#cbw-messages .cbw-row.user .cbw-avatar { background: var(--surface-elevated, #1a1a1f); border: 1px solid var(--border, rgba(255,255,255,.1)); color: var(--text-muted, rgba(244,244,240,.7)); }",

    "#cbw-messages .cbw-msg { padding: 9px 12px; border-radius: 14px; font-size: 13px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }",
    "#cbw-messages .cbw-row.user .cbw-msg { background: var(--accent-gradient, var(--accent)); color: #fff; border-bottom-right-radius: 4px; }",
    "#cbw-messages .cbw-row.assistant .cbw-msg { background: var(--surface-alt, #1c1c21); color: var(--text, #F4F4F0); border: 1px solid var(--border, rgba(255,255,255,.08)); border-bottom-left-radius: 4px; }",
    "#cbw-messages .cbw-msg.error { border-color: #d14343 !important; color: #ff8a8a !important; background: rgba(209,67,67,.08) !important; }",
    "#cbw-messages .cbw-msg.typing::after { content: ''; display: inline-block; width: 7px; height: 13px; margin-left: 2px; vertical-align: -2px;",
    "  background: var(--accent, #FF5B2E); animation: cbw-caret .85s step-end infinite; }",
    "@keyframes cbw-caret { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }",

    "#cbw-dots { display: inline-flex; align-items: center; gap: 4px; padding: 3px 0; }",
    "#cbw-dots span { width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted, rgba(244,244,240,.55)); animation: cbw-bounce 1.1s ease-in-out infinite; }",
    "#cbw-dots span:nth-child(2) { animation-delay: .15s; }",
    "#cbw-dots span:nth-child(3) { animation-delay: .3s; }",
    "@keyframes cbw-bounce { 0%, 60%, 100% { transform: translateY(0); opacity: .5; } 30% { transform: translateY(-4px); opacity: 1; } }",

    "#cbw-form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid var(--border, rgba(255,255,255,.08)); background: var(--surface, #16161A); }",
    "#cbw-input { flex: 1; background: var(--surface-alt, #1c1c21); border: 1px solid var(--border, rgba(255,255,255,.08));",
    "  border-radius: 999px; color: var(--text, #F4F4F0); font-size: 13px; padding: 9px 14px; font-family: inherit; transition: border-color .15s; }",
    "#cbw-input:focus { outline: none; border-color: var(--accent, #FF5B2E); }",
    "#cbw-send { background: var(--accent-gradient, var(--accent)); color: #fff; border: none; border-radius: 50%;",
    "  width: 36px; height: 36px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: transform .15s, opacity .15s; }",
    "#cbw-send svg { width: 16px; height: 16px; }",
    "#cbw-send:hover:not(:disabled) { transform: scale(1.07); }",
    "#cbw-send:disabled { opacity: .45; cursor: default; }",

    "@media (max-width: 480px) { #cbw-panel { width: calc(100vw - 32px); right: -4px; } }",
  ].join("\n");

  function injectStyle() {
    var tag = document.createElement("style");
    tag.id = "cbw-style";
    tag.textContent = STYLE;
    document.head.appendChild(tag);
  }

  var CHAT_ICON =
    '<svg class="cbw-icon-chat" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
  var CLOSE_ICON =
    '<svg class="cbw-icon-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  var SEND_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/></svg>';

  function buildDom() {
    var root = document.createElement("div");
    root.id = "cbw-root";
    root.innerHTML =
      '<div id="cbw-panel">' +
      '  <div id="cbw-header">' +
      '    <div id="cbw-header-text"><strong>Concap Assistant</strong>' +
      '      <span><span id="cbw-status-dot"></span>Leads, conversations &amp; sessions</span>' +
      "    </div>" +
      '    <button id="cbw-close" type="button" aria-label="Close">&times;</button>' +
      "  </div>" +
      '  <div id="cbw-messages"></div>' +
      '  <form id="cbw-form">' +
      '    <input id="cbw-input" type="text" autocomplete="off" placeholder="Ask about your leads…" />' +
      '    <button id="cbw-send" type="submit" aria-label="Send">' + SEND_ICON + "</button>" +
      "  </form>" +
      "</div>" +
      '<button id="cbw-toggle" type="button" aria-label="Open assistant">' + CHAT_ICON + CLOSE_ICON + "</button>";
    document.body.appendChild(root);
    return root;
  }

  function appendRow(container, role, avatarLabel) {
    var row = document.createElement("div");
    row.className = "cbw-row " + role;
    var avatar = document.createElement("div");
    avatar.className = "cbw-avatar";
    avatar.textContent = avatarLabel;
    var msg = document.createElement("div");
    msg.className = "cbw-msg";
    row.appendChild(avatar);
    row.appendChild(msg);
    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
    return msg;
  }

  // Reveals `text` into `el` a few characters at a time, scaled so even a
  // long reply finishes in roughly TYPE_DURATION_MS — a brief "typing" feel
  // without making the user wait on a slow per-character animation.
  var TYPE_DURATION_MS = 700;
  var TYPE_TICK_MS = 16;
  function typeIn(el, text, container, onDone) {
    el.textContent = "";
    el.classList.add("typing");
    var total = text.length;
    if (total === 0) {
      el.classList.remove("typing");
      if (onDone) onDone();
      return;
    }
    var ticks = Math.max(1, Math.round(TYPE_DURATION_MS / TYPE_TICK_MS));
    var chunk = Math.max(1, Math.ceil(total / ticks));
    var i = 0;
    var timer = setInterval(function () {
      i = Math.min(total, i + chunk);
      el.textContent = text.slice(0, i);
      container.scrollTop = container.scrollHeight;
      if (i >= total) {
        clearInterval(timer);
        el.classList.remove("typing");
        if (onDone) onDone();
      }
    }, TYPE_TICK_MS);
  }

  function init() {
    var user = window.Auth.getUser();
    var me = initials(user);
    injectStyle();
    var root = buildDom();

    var toggle = root.querySelector("#cbw-toggle");
    var panel = root.querySelector("#cbw-panel");
    var closeBtn = root.querySelector("#cbw-close");
    var messages = root.querySelector("#cbw-messages");
    var form = root.querySelector("#cbw-form");
    var input = root.querySelector("#cbw-input");
    var sendBtn = root.querySelector("#cbw-send");

    // Client-side thread so the backend stays stateless. `history` is capped
    // to the last few turns before sending — mirrors
    // chatbot_ai.MAX_HISTORY_MESSAGES. `thread` is the fuller display log
    // (rendered text + bubble style) restored verbatim on the next page.
    var saved = loadThreadState(user && user.email);
    var history = (saved && saved.history) || [];
    var thread = (saved && saved.thread) || [];
    var greeted = !!(saved && saved.greeted);
    var wasOpen = !!(saved && saved.open);

    function persist(isOpen) {
      saveThreadState({
        userEmail: user && user.email,
        open: isOpen,
        greeted: greeted,
        history: history,
        thread: thread,
      });
    }

    function recordThread(role, text, cls) {
      thread.push({ role: role, text: text, cls: cls || null });
      if (thread.length > 30) thread = thread.slice(-30);
      persist(panel.classList.contains("open"));
    }

    // Replay whatever was on screen before the last navigation, instantly
    // (no typewriter — only a fresh reply gets that treatment).
    thread.forEach(function (m) {
      var el = appendRow(messages, m.role, m.role === "user" ? me : "AI");
      el.textContent = m.text;
      if (m.cls) el.classList.add(m.cls);
    });

    function setOpen(isOpen) {
      panel.classList.toggle("open", isOpen);
      toggle.classList.toggle("open", isOpen);
      if (isOpen) {
        if (!greeted) {
          greeted = true;
          var greeting =
            "Hi " + firstName(user) + "! Ask me about your Conversations, Hot leads, Warm leads, or Sessions.";
          var msg = appendRow(messages, "assistant", "AI");
          typeIn(msg, greeting, messages);
          recordThread("assistant", greeting);
        }
        input.focus();
      }
      persist(isOpen);
    }

    toggle.addEventListener("click", function () {
      setOpen(!panel.classList.contains("open"));
    });
    closeBtn.addEventListener("click", function () {
      setOpen(false);
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text) return;
      input.value = "";
      sendBtn.disabled = true;

      appendRow(messages, "user", me).textContent = text;
      recordThread("user", text);

      var pendingMsg = appendRow(messages, "assistant", "AI");
      pendingMsg.innerHTML = '<span id="cbw-dots"><span></span><span></span><span></span></span>';

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
          var reply = stripMarkdown(data.reply);
          typeIn(pendingMsg, reply, messages);
          history.push({ role: "user", content: text });
          history.push({ role: "assistant", content: data.reply });
          if (history.length > 12) history = history.slice(-12);
          recordThread("assistant", reply);
        })
        .catch(function (err) {
          var errText = err.message || "Something went wrong — please try again.";
          pendingMsg.classList.add("error");
          typeIn(pendingMsg, errText, messages);
          recordThread("assistant", errText, "error");
        })
        .finally(function () {
          sendBtn.disabled = false;
          input.focus();
        });
    });

    // Reopen already-open from before the navigation, without re-greeting
    // (greeted is already true if the saved thread had anything in it).
    if (wasOpen) setOpen(true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
