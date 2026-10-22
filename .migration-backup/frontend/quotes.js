/* Quote agent — a chat workspace for drafting and refining proposals.
 *
 * Authorization is attached by auth.js's patched fetch. Binary downloads
 * (PDF/DOCX) are fetched as blobs (NOT <a href>) so the auth header is sent.
 * Drafting is conversational: POST /api/quotes/chat with no quote_id starts a
 * proposal from the chosen context chips; with a quote_id it refines and appends
 * to the thread. The proposal editor still saves manual edits via PUT. */
(function () {
  "use strict";
  const API = "";

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtDate(s) {
    if (!s) return "";
    const d = new Date(s);
    if (isNaN(d)) return "";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  function money(cur, n) {
    const v = Number(n || 0);
    return (cur || "$") + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Render the proposal's constrained formatting subset (blank-line paragraphs,
  // "- " bullets, "## " sub-headings, **bold**) into safe HTML for the preview.
  // Tolerant of loose model output — text is escaped first, then markers apply.
  function inlineFmt(escaped) {
    return escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }
  function renderProposalHTML(text) {
    const src = String(text == null ? "" : text);
    if (!src.trim()) return "<p class='pp-empty'>Your formatted proposal will appear here.</p>";
    const lines = src.split(/\r?\n/);
    let html = "", inList = false;
    function closeList() { if (inList) { html += "</ul>"; inList = false; } }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) { closeList(); continue; }
      const h = line.match(/^#{1,6}(?:\s+(.*\S))?\s*$/);
      const b = line.match(/^[-*\u2022](?:\s+(.*\S))?\s*$/);
      if (h) {
        closeList();
        const ht = (h[1] || "").trim();
        if (ht) html += "<h4>" + inlineFmt(esc(ht)) + "</h4>";
      } else if (b) {
        const it = (b[1] || "").trim();
        if (it) {
          if (!inList) { html += "<ul>"; inList = true; }
          html += "<li>" + inlineFmt(esc(it)) + "</li>";
        }
      } else {
        closeList();
        html += "<p>" + inlineFmt(esc(line)) + "</p>";
      }
    }
    closeList();
    return html;
  }

  let quotes = [];
  let current = null;       // full quote object being edited
  // Composer (new proposal) context chips.
  let ctx = { conversations: [], contact: null, company: null };
  // Open-quote workspace grounding context (from GET /context, edited in-thread).
  let quoteCtx = { conversations: [], visitor: null, company: null };
  // Document-attachment pickers. composerPicker persists for the static composer;
  // chatPicker is recreated each time the open-quote chat input is re-rendered.
  let composerPicker = null;
  let chatPicker = null;
  // Multi-brand: the org's brands (summaries, incl. templates) for the composer
  // selector. Loaded once; the brand row is hidden when the org has no brands.
  let brandsList = [];

  function emptyCtx() { return { conversations: [], visitor: null, company: null }; }

  // A small file-attachment widget: tracks chosen File objects in JS (an <input
  // type=file> can't have entries removed), renders removable name chips, and
  // lets re-selecting the same file work by resetting the input after each pick.
  function makeFilePicker(btnId, inputId, listId) {
    const input = $(inputId);
    const list = $(listId);
    const btn = $(btnId);
    if (!input || !list) return { files: function () { return []; }, clear: function () {} };
    let files = [];
    function render() {
      list.innerHTML = files.map(function (f, i) {
        return "<span class='file-chip'><span class='fc-name'>" + esc(f.name) +
          "</span><span class='x' data-i='" + i + "' title='Remove'>×</span></span>";
      }).join("");
      Array.prototype.forEach.call(list.querySelectorAll(".x"), function (x) {
        x.addEventListener("click", function () {
          files.splice(parseInt(x.getAttribute("data-i"), 10), 1);
          render();
        });
      });
    }
    if (btn) btn.addEventListener("click", function () { input.click(); });
    input.addEventListener("change", function () {
      Array.prototype.push.apply(files, Array.prototype.slice.call(input.files || []));
      input.value = "";  // allow re-picking the same file
      render();
    });
    return {
      files: function () { return files.slice(); },
      clear: function () { files = []; render(); },
    };
  }

  // POST a chat turn. When documents are attached, send multipart to /chat/upload
  // (the browser sets the multipart boundary; auth.js only adds Authorization, so
  // it won't clobber Content-Type). Otherwise send the plain JSON /chat request.
  async function postChat(payload, files) {
    if (files && files.length) {
      const fd = new FormData();
      fd.append("message", payload.message);
      if (payload.quote_id != null) fd.append("quote_id", String(payload.quote_id));
      if (payload.conversation_ids) fd.append("conversation_ids", JSON.stringify(payload.conversation_ids));
      if (payload.visitor_id != null) fd.append("visitor_id", String(payload.visitor_id));
      if (payload.company_id != null) fd.append("company_id", String(payload.company_id));
      if (payload.brand_id != null) fd.append("brand_id", String(payload.brand_id));
      if (payload.template_id) fd.append("template_id", String(payload.template_id));
      files.forEach(function (f) { fd.append("files", f); });
      const r = await fetch(API + "/api/quotes/chat/upload", { method: "POST", body: fd });
      if (!r.ok) throw new Error(await errDetail(r));
      return await r.json();
    }
    const r = await fetch(API + "/api/quotes/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(await errDetail(r));
    return await r.json();
  }

  // The documents already grounded into a proposal, shown in the chat header.
  function attachedDocsHTML(q) {
    const meta = (q && q.attachments_meta) || [];
    if (!meta.length) return "";
    return "<div class='chat-attached'>" +
      meta.map(function (m) {
        return "<span class='doc-tag'>📄 " + esc(m.name || "document") + "</span>";
      }).join("") +
      "</div>";
  }

  // ---- list ----------------------------------------------------------------
  async function loadList(selectId) {
    try {
      const r = await fetch(API + "/api/quotes");
      if (!r.ok) throw new Error("status " + r.status);
      quotes = await r.json();
    } catch (e) {
      $("q-list").innerHTML = "<div class='muted'>Couldn't load quotes (" + esc(e.message) + ")</div>";
      return;
    }
    renderList();
    if (selectId) openQuote(selectId);
  }

  function renderList() {
    const el = $("q-list");
    const toggle = $("proposals-toggle");
    if (toggle) toggle.textContent = "☰ Past proposals" + (quotes.length ? " (" + quotes.length + ")" : "");
    if (!quotes.length) {
      el.innerHTML = "<div class='muted'>No quotes yet. Click “New proposal” to start your first one.</div>";
      return;
    }
    el.innerHTML = quotes.map(function (q) {
      const active = current && current.id === q.id ? " active" : "";
      const who = q.client_company || q.client_name || "—";
      const brand = q.brand_name
        ? "<span class='pill' style='text-transform:none;'>" + esc(q.brand_name) + "</span>"
        : "";
      return (
        "<div class='q-item" + active + "' data-id='" + q.id + "'>" +
          "<strong>" + esc(q.title || "Proposal") + "</strong>" +
          "<span class='sub'>" + esc(who) + "</span>" +
          "<div class='meta'>" +
            "<span class='pill " + esc(q.status) + "'>" + esc(q.status) + "</span>" +
            brand +
            "<span>" + esc(money(q.currency, q.totals && q.totals.total)) + "</span>" +
          "</div>" +
        "</div>"
      );
    }).join("");
    Array.prototype.forEach.call(el.querySelectorAll(".q-item"), function (node) {
      node.addEventListener("click", function () { openQuote(+node.dataset.id); closeDrawer(); });
    });
  }

  // ---- open quote (chat + editor) -----------------------------------------
  async function openQuote(id) {
    try {
      const [qr, cr] = await Promise.all([
        fetch(API + "/api/quotes/" + id),
        fetch(API + "/api/quotes/" + id + "/context"),
      ]);
      if (!qr.ok) throw new Error("status " + qr.status);
      current = await qr.json();
      quoteCtx = cr.ok ? await cr.json() : emptyCtx();
    } catch (e) {
      alert("Couldn't open quote: " + e.message);
      return;
    }
    showView("quote");
    renderQuoteView();
    renderList();
  }

  function showView(which) {
    $("empty-state").style.display = which === "empty" ? "block" : "none";
    $("composer").style.display = which === "composer" ? "block" : "none";
    $("quote-view").style.display = which === "quote" ? "block" : "none";
  }

  // ---- past-proposals slide-out panel -------------------------------------
  function openDrawer() {
    document.body.classList.add("q-drawer-open");
    const t = $("proposals-toggle");
    if (t) t.setAttribute("aria-expanded", "true");
    const d = $("q-drawer");
    if (d) d.setAttribute("aria-hidden", "false");
  }
  function closeDrawer() {
    document.body.classList.remove("q-drawer-open");
    const t = $("proposals-toggle");
    if (t) t.setAttribute("aria-expanded", "false");
    const d = $("q-drawer");
    if (d) d.setAttribute("aria-hidden", "true");
  }
  function toggleDrawer() {
    if (document.body.classList.contains("q-drawer-open")) closeDrawer();
    else openDrawer();
  }

  function renderMsg(m) {
    const role = m && m.role === "user" ? "user" : "assistant";
    return "<div class='msg " + role + "'>" + esc(m && m.text || "") + "</div>";
  }

  function liRow(li, i) {
    return (
      "<tr data-i='" + i + "'>" +
        "<td><input type='text' class='li-desc' value='" + esc(li.description) + "' placeholder='Description' /></td>" +
        "<td class='num' style='width:80px;'><input type='number' class='li-qty' step='any' min='0' value='" + esc(li.quantity) + "' /></td>" +
        "<td class='num' style='width:110px;'><input type='number' class='li-price' step='any' min='0' value='" + esc(li.unit_price) + "' /></td>" +
        "<td class='li-amt' style='width:100px;'>" + money(current.currency, (Number(li.quantity) || 0) * (Number(li.unit_price) || 0)) + "</td>" +
        "<td class='li-del' title='Remove'>✕</td>" +
      "</tr>"
    );
  }

  function editorHTML(q) {
    const items = q.line_items || [];
    return (
      "<h3>Proposal</h3>" +
      "<div class='field'><label>Title</label><input type='text' id='f-title' value='" + esc(q.title) + "' /></div>" +
      "<div class='row2'>" +
        "<div class='field'><label>Client name</label><input type='text' id='f-client_name' value='" + esc(q.client_name || "") + "' /></div>" +
        "<div class='field'><label>Client company</label><input type='text' id='f-client_company' value='" + esc(q.client_company || "") + "' /></div>" +
      "</div>" +
      "<div class='field'><label>Proposal narrative</label>" +
        "<div class='prop-preview' id='prop-preview'>" + renderProposalHTML(q.proposal_text || "") + "</div>" +
        "<textarea id='f-proposal_text' style='min-height:150px;' placeholder='Short paragraphs. Start a line with \"- \" for a bullet, or \"## \" for a sub-heading.'>" + esc(q.proposal_text || "") + "</textarea>" +
      "</div>" +

      "<label class='muted'>Line items</label>" +
      "<table class='li'><thead><tr><th>Description</th><th style='text-align:right;'>Qty</th><th style='text-align:right;'>Unit price</th><th style='text-align:right;'>Amount</th><th></th></tr></thead>" +
      "<tbody id='li-body'>" + items.map(liRow).join("") + "</tbody></table>" +
      "<button class='btn-secondary' id='add-li' style='margin-top:8px;'>+ Add line item</button>" +

      "<div class='row3' style='margin-top:16px;'>" +
        "<div class='field'><label>Currency</label><input type='text' id='f-currency' maxlength='4' value='" + esc(q.currency || "$") + "' /></div>" +
        "<div class='field'><label>Tax %</label><input type='number' id='f-tax_percent' step='any' min='0' value='" + esc(q.tax_percent || 0) + "' /></div>" +
        "<div class='field'><label>Discount %</label><input type='number' id='f-discount_percent' step='any' min='0' value='" + esc(q.discount_percent || 0) + "' /></div>" +
      "</div>" +

      "<div class='totals' id='totals'></div>" +

      "<div class='field' style='margin-top:14px;'><label>Notes / terms</label><textarea id='f-notes'>" + esc(q.notes || "") + "</textarea></div>" +

      "<div class='toolbar'>" +
        "<select id='f-status'>" +
          "<option value='draft'" + (q.status === "draft" ? " selected" : "") + ">Draft</option>" +
          "<option value='final'" + (q.status === "final" ? " selected" : "") + ">Final</option>" +
        "</select>" +
        "<div class='spacer'></div>" +
        "<span class='toast' id='ed-toast'></span>" +
        "<button class='btn-primary' id='save-quote'>Save changes</button>" +
      "</div>"
    );
  }

  function renderQuoteView() {
    const q = current;
    const msgs = q.chat_messages || [];
    $("quote-view").innerHTML =
      "<div class='card'>" +
        "<div class='toolbar'>" +
          "<span class='pill " + esc(q.status) + "'>" + esc(q.status) + "</span>" +
          "<span class='muted'>" + esc(q.source_type || "") +
            (q.version_count ? " · " + q.version_count + " revision(s)" : "") + "</span>" +
          "<div class='spacer'></div>" +
          "<button class='btn-secondary' id='dl-pdf'>Download PDF</button>" +
          "<button class='btn-secondary' id='dl-docx'>Download Word</button>" +
          "<button class='btn-secondary' id='del-quote'>Delete</button>" +
        "</div>" +

        "<div class='ws-split'>" +
          "<div class='chat-pane'>" +
            "<div class='chat-head'>Chat with the agent to refine this proposal." + attachedDocsHTML(q) + "</div>" +
            "<div class='ws-context' id='wctx-area'></div>" +
            "<div class='chat-thread' id='chat-thread'>" + msgs.map(renderMsg).join("") + "</div>" +
            "<div class='chat-input'>" +
              "<div class='chat-input-main'>" +
                "<textarea id='chat-msg' placeholder='Ask for changes… e.g. add a 12-month support retainer and make the tone more formal'></textarea>" +
                "<div class='attach-row'>" +
                  "<button type='button' class='btn-attach' id='chat-attach-btn'>📎 Attach</button>" +
                  "<input type='file' id='chat-files' multiple accept='.pdf,.docx,.txt,.md' style='display:none;'>" +
                  "<div class='file-list' id='chat-file-list'></div>" +
                "</div>" +
              "</div>" +
              "<button class='btn-primary' id='chat-send'>Send</button>" +
            "</div>" +
          "</div>" +
          "<div class='editor-pane'>" + editorHTML(q) + "</div>" +
        "</div>" +
      "</div>";

    bindQuoteView();
    renderContextBar();
    recalcTotals();
    scrollThread();
  }

  // ---- workspace context (in-thread, removable chips) ---------------------
  function renderContextBar() {
    const area = $("wctx-area");
    if (!area) return;
    const chips = [];
    (quoteCtx.conversations || []).forEach(function (c) {
      chips.push(chipHTML("conversation", c.id, c.label));
    });
    if (quoteCtx.visitor) chips.push(chipHTML("contact", quoteCtx.visitor.id, "Contact: " + quoteCtx.visitor.name));
    if (quoteCtx.company) chips.push(chipHTML("company", quoteCtx.company.id, "Company: " + quoteCtx.company.name));
    area.innerHTML =
      "<div class='wctx-label'>Source context — grounds every reply</div>" +
      "<div class='chips' id='wctx-chips'>" +
        (chips.length ? chips.join("") : "<span class='none'>No source attached.</span>") +
      "</div>" +
      "<div class='ctx-add'>" +
        "<select id='wctx-type'>" +
          "<option value='conversation'>Conversation</option>" +
          "<option value='contact'>Contact</option>" +
          "<option value='company'>Company</option>" +
        "</select>" +
        "<select id='wctx-pick'><option>Loading…</option></select>" +
        "<button class='btn-secondary' id='wctx-add'>+ Add</button>" +
      "</div>";
    Array.prototype.forEach.call($("wctx-chips").querySelectorAll(".x"), function (x) {
      x.addEventListener("click", function () { removeQuoteCtx(x.dataset.kind, +x.dataset.id); });
    });
    $("wctx-type").addEventListener("change", function () { loadPicker("wctx-pick", $("wctx-type").value); });
    $("wctx-add").addEventListener("click", addQuoteCtx);
    loadPicker("wctx-pick", "conversation");
  }

  function desiredCtx() {
    return {
      conversation_ids: (quoteCtx.conversations || []).map(function (c) { return c.id; }),
      visitor_id: quoteCtx.visitor ? quoteCtx.visitor.id : null,
      company_id: quoteCtx.company ? quoteCtx.company.id : null,
    };
  }

  function addQuoteCtx() {
    const t = $("wctx-type").value;
    const sel = $("wctx-pick");
    const val = sel.value;
    if (!val) return;
    const id = +val;
    const d = desiredCtx();
    if (t === "conversation") {
      if (d.conversation_ids.indexOf(id) === -1) d.conversation_ids.push(id);
    } else if (t === "contact") {
      d.visitor_id = id;
    } else {
      d.company_id = id;
    }
    putContext(d);
  }

  function removeQuoteCtx(kind, id) {
    const d = desiredCtx();
    if (kind === "conversation") {
      d.conversation_ids = d.conversation_ids.filter(function (x) { return x !== id; });
    } else if (kind === "contact") {
      d.visitor_id = null;
    } else if (kind === "company") {
      d.company_id = null;
    }
    putContext(d);
  }

  async function putContext(desired) {
    const add = $("wctx-add");
    if (add) add.disabled = true;
    try {
      const r = await fetch(API + "/api/quotes/" + current.id + "/context", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(desired),
      });
      if (!r.ok) throw new Error(await errDetail(r));
      quoteCtx = await r.json();
      renderContextBar();
      edToast("Source context updated.", "ok");
    } catch (e) {
      edToast("Couldn't update context: " + e.message, "err");
      if (add) add.disabled = false;
    }
  }

  function scrollThread() {
    const t = $("chat-thread");
    if (t) t.scrollTop = t.scrollHeight;
  }

  function readLineItems() {
    const rows = $("li-body").querySelectorAll("tr");
    const items = [];
    Array.prototype.forEach.call(rows, function (tr) {
      const desc = tr.querySelector(".li-desc").value.trim();
      const qty = parseFloat(tr.querySelector(".li-qty").value) || 0;
      const price = parseFloat(tr.querySelector(".li-price").value) || 0;
      if (desc) items.push({ description: desc, quantity: qty, unit_price: price });
    });
    return items;
  }

  function recalcTotals() {
    if (!$("f-currency")) return;
    const cur = $("f-currency").value.trim() || "$";
    const items = readLineItems();
    let subtotal = 0;
    items.forEach(function (li) { subtotal += li.quantity * li.unit_price; });
    const disc = subtotal * (parseFloat($("f-discount_percent").value) || 0) / 100;
    const taxed = subtotal - disc;
    const tax = taxed * (parseFloat($("f-tax_percent").value) || 0) / 100;
    const total = taxed + tax;
    $("totals").innerHTML =
      "<div class='t-row'><span>Subtotal</span><span>" + money(cur, subtotal) + "</span></div>" +
      (disc ? "<div class='t-row'><span>Discount</span><span>-" + money(cur, disc) + "</span></div>" : "") +
      (tax ? "<div class='t-row'><span>Tax</span><span>" + money(cur, tax) + "</span></div>" : "") +
      "<div class='t-row grand'><span>Total</span><span>" + money(cur, total) + "</span></div>";
    const rows = $("li-body").querySelectorAll("tr");
    Array.prototype.forEach.call(rows, function (tr) {
      const qty = parseFloat(tr.querySelector(".li-qty").value) || 0;
      const price = parseFloat(tr.querySelector(".li-price").value) || 0;
      tr.querySelector(".li-amt").textContent = money(cur, qty * price);
    });
  }

  function bindQuoteView() {
    $("add-li").addEventListener("click", function () {
      const tbody = $("li-body");
      const i = tbody.querySelectorAll("tr").length;
      tbody.insertAdjacentHTML("beforeend", liRow({ description: "", quantity: 1, unit_price: 0 }, i));
      bindRowEvents();
      recalcTotals();
    });
    bindRowEvents();
    ["f-currency", "f-tax_percent", "f-discount_percent"].forEach(function (id) {
      $(id).addEventListener("input", recalcTotals);
    });
    const propEl = $("f-proposal_text");
    if (propEl) propEl.addEventListener("input", function () {
      const pv = $("prop-preview");
      if (pv) pv.innerHTML = renderProposalHTML(propEl.value);
    });
    $("save-quote").addEventListener("click", saveQuote);
    $("del-quote").addEventListener("click", deleteQuote);
    $("dl-pdf").addEventListener("click", function () { download("pdf"); });
    $("dl-docx").addEventListener("click", function () { download("docx"); });
    $("chat-send").addEventListener("click", chatSend);
    $("chat-msg").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); chatSend(); }
    });
    // The chat input is rebuilt on every render, so (re)create its picker here.
    chatPicker = makeFilePicker("chat-attach-btn", "chat-files", "chat-file-list");
  }

  function bindRowEvents() {
    const tbody = $("li-body");
    Array.prototype.forEach.call(tbody.querySelectorAll("tr"), function (tr) {
      tr.querySelector(".li-qty").oninput = recalcTotals;
      tr.querySelector(".li-price").oninput = recalcTotals;
      tr.querySelector(".li-del").onclick = function () { tr.remove(); recalcTotals(); };
    });
  }

  function edToast(msg, kind) {
    const t = $("ed-toast");
    if (!t) return;
    t.textContent = msg;
    t.className = "toast " + (kind || "");
    if (msg && kind === "ok") setTimeout(function () { if (t.textContent === msg) t.textContent = ""; }, 3500);
  }

  function editorPayload() {
    return {
      title: $("f-title").value,
      client_name: $("f-client_name").value,
      client_company: $("f-client_company").value,
      proposal_text: $("f-proposal_text").value,
      line_items: readLineItems(),
      currency: $("f-currency").value,
      tax_percent: parseFloat($("f-tax_percent").value) || 0,
      discount_percent: parseFloat($("f-discount_percent").value) || 0,
      notes: $("f-notes").value,
      status: $("f-status").value,
    };
  }

  // PUT the on-screen editor state. Returns the saved quote; throws on failure.
  async function persist() {
    const r = await fetch(API + "/api/quotes/" + current.id, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editorPayload()),
    });
    if (!r.ok) throw new Error(await errDetail(r));
    current = await r.json();
    return current;
  }

  async function saveQuote() {
    const btn = $("save-quote");
    btn.disabled = true;
    edToast("Saving…");
    try {
      await persist();
      renderQuoteView();
      edToast("Saved.", "ok");
      loadList();
    } catch (e) {
      edToast(e.message, "err");
      btn.disabled = false;
    }
  }

  async function chatSend() {
    const input = $("chat-msg");
    const message = input.value.trim();
    if (!message) { edToast("Type a message first.", "err"); return; }
    const btn = $("chat-send");
    btn.disabled = true;
    btn.innerHTML = "<span class='spinner'></span>";
    edToast("");
    // Persist any manual edits first so the agent refines what's on screen.
    try {
      await persist();
    } catch (e) {
      edToast("Couldn't save current edits: " + e.message, "err");
      btn.disabled = false;
      btn.textContent = "Send";
      return;
    }
    // Optimistically show the user's message.
    const thread = $("chat-thread");
    thread.insertAdjacentHTML("beforeend", renderMsg({ role: "user", text: message }));
    thread.insertAdjacentHTML("beforeend",
      "<div class='msg assistant' id='pending-msg'><span class='spinner'></span> Thinking…</div>");
    input.value = "";
    scrollThread();
    const files = chatPicker ? chatPicker.files() : [];
    try {
      current = await postChat({ quote_id: current.id, message: message }, files);
      renderQuoteView();
      loadList();
    } catch (e) {
      const pending = $("pending-msg");
      if (pending) { pending.classList.add("err"); pending.textContent = "Couldn't apply that: " + e.message; }
      btn.disabled = false;
      btn.textContent = "Send";
    }
  }

  async function deleteQuote() {
    if (!confirm("Delete this quote? This can't be undone.")) return;
    try {
      const r = await fetch(API + "/api/quotes/" + current.id, { method: "DELETE" });
      if (!r.ok && r.status !== 204) throw new Error(await errDetail(r));
    } catch (e) {
      alert(e.message);
      return;
    }
    current = null;
    showView("empty");
    loadList();
  }

  async function download(kind) {
    const id = kind === "pdf" ? "dl-pdf" : "dl-docx";
    const btn = $(id);
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Preparing…";
    try {
      // Save first so the export reflects on-screen edits.
      await persist();
      const r = await fetch(API + "/api/quotes/" + current.id + "/export." + kind);
      if (!r.ok) throw new Error(await errDetail(r));
      const blob = await r.blob();
      const cd = r.headers.get("Content-Disposition") || "";
      const m = cd.match(/filename="?([^"]+)"?/);
      const name = (m && m[1]) || ("proposal." + kind);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    } catch (e) {
      edToast(e.message, "err");
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  async function errDetail(r) {
    try { return (await r.json()).detail || ("status " + r.status); }
    catch (e) { return "status " + r.status; }
  }

  // ---- composer (new proposal) --------------------------------------------
  function openComposer() {
    ctx = { conversations: [], contact: null, company: null };
    closeDrawer();
    showView("composer");
    $("composer-msg").value = "Draft a proposal based on these conversations.";
    $("composer-toast").textContent = "";
    renderChips();
    if (composerPicker) composerPicker.clear();
    $("ctx-type").value = "conversation";
    loadPicker("ctx-pick", "conversation");
    populateBrandSelect();
  }

  function closeComposer() {
    showView(current ? "quote" : "empty");
  }

  function renderChips() {
    const parts = [];
    ctx.conversations.forEach(function (c) {
      parts.push(chipHTML("conversation", c.id, c.label));
    });
    if (ctx.contact) parts.push(chipHTML("contact", ctx.contact.id, "Contact: " + ctx.contact.label));
    if (ctx.company) parts.push(chipHTML("company", ctx.company.id, "Company: " + ctx.company.label));
    $("ctx-chips").innerHTML = parts.length ? parts.join("") : "<span class='none'>Nothing added yet.</span>";
    Array.prototype.forEach.call($("ctx-chips").querySelectorAll(".x"), function (x) {
      x.addEventListener("click", function () { removeChip(x.dataset.kind, +x.dataset.id); });
    });
  }

  function chipHTML(kind, id, label) {
    return "<span class='chip kind-" + kind + "'>" + esc(label) +
      "<span class='x' data-kind='" + kind + "' data-id='" + id + "'>✕</span></span>";
  }

  function removeChip(kind, id) {
    if (kind === "conversation") {
      ctx.conversations = ctx.conversations.filter(function (c) { return c.id !== id; });
    } else if (kind === "contact") {
      ctx.contact = null;
    } else if (kind === "company") {
      ctx.company = null;
    }
    renderChips();
  }

  async function loadPicker(selId, t) {
    const sel = $(selId);
    if (!sel) return;
    sel.innerHTML = "<option value=''>Loading…</option>";
    let url, mapper;
    if (t === "conversation") {
      url = "/api/conversations";
      mapper = function (c) {
        const who = c.visitor_company || c.visitor_name || "Conversation";
        const topic = c.topic ? " — " + c.topic : "";
        return { v: c.id, t: who + topic + " (" + fmtDate(c.created_at) + ")" };
      };
    } else if (t === "contact") {
      url = "/api/visitors";
      mapper = function (v) { return { v: v.id, t: v.name + (v.company ? " · " + v.company : "") }; };
    } else {
      url = "/api/companies";
      mapper = function (c) { return { v: c.id, t: c.name }; };
    }
    try {
      const r = await fetch(API + url);
      if (!r.ok) throw new Error("status " + r.status);
      const rows = await r.json();
      if (!rows.length) {
        sel.innerHTML = "<option value=''>Nothing available yet</option>";
        return;
      }
      sel.innerHTML = rows.map(function (row) {
        const o = mapper(row);
        return "<option value='" + o.v + "'>" + esc(o.t) + "</option>";
      }).join("");
    } catch (e) {
      sel.innerHTML = "<option value=''>Couldn't load (" + esc(e.message) + ")</option>";
    }
  }

  function addChip() {
    const t = $("ctx-type").value;
    const sel = $("ctx-pick");
    const val = sel.value;
    if (!val || !Number.isFinite(+val)) return;
    const label = sel.options[sel.selectedIndex].text;
    const id = +val;
    if (t === "conversation") {
      if (!ctx.conversations.some(function (c) { return c.id === id; })) {
        ctx.conversations.push({ id: id, label: label });
      }
    } else if (t === "contact") {
      ctx.contact = { id: id, label: label };
    } else {
      ctx.company = { id: id, label: label };
    }
    renderChips();
  }

  async function composerSend() {
    const message = $("composer-msg").value.trim();
    function toast(msg, kind) {
      $("composer-toast").textContent = msg;
      $("composer-toast").className = "toast " + (kind || "");
    }
    // Forgiving UX: people naturally pick a conversation in the dropdown and hit
    // "Start proposal" without first clicking "+ Add". If nothing has been added
    // yet, fold the current dropdown selection in so it just works.
    if (!ctx.conversations.length && !ctx.contact && !ctx.company) {
      addChip();
    }
    const hasContext = ctx.conversations.length || ctx.contact || ctx.company;
    if (!hasContext) { toast("Add at least one conversation, contact, or company.", "err"); return; }
    if (!message) { toast("Tell the agent what you need.", "err"); return; }

    const btn = $("composer-send");
    btn.disabled = true;
    btn.innerHTML = "<span class='spinner'></span> Drafting";
    toast("The agent is drafting your proposal…");
    const body = { message: message };
    if (ctx.conversations.length) body.conversation_ids = ctx.conversations.map(function (c) { return c.id; });
    if (ctx.contact) body.visitor_id = ctx.contact.id;
    if (ctx.company) body.company_id = ctx.company.id;
    const brandSel = $("composer-brand");
    if (brandSel && brandSel.value) {
      body.brand_id = parseInt(brandSel.value, 10);
      const tSel = $("composer-template");
      if (tSel && tSel.value) body.template_id = tSel.value;
    }
    try {
      const q = await postChat(body, composerPicker ? composerPicker.files() : []);
      if (composerPicker) composerPicker.clear();
      await loadList(q.id);
    } catch (e) {
      toast(e.message, "err");
      btn.disabled = false;
      btn.textContent = "Start proposal";
    }
  }

  // ---- brand selector -----------------------------------------------------
  async function loadBrands() {
    try {
      const r = await fetch(API + "/api/brands");
      if (!r.ok) return;
      brandsList = await r.json();
    } catch (e) { brandsList = []; }
    populateBrandSelect();
  }

  function populateBrandSelect() {
    const row = $("brand-row");
    const sel = $("composer-brand");
    if (!row || !sel) return;
    if (!brandsList.length) { row.style.display = "none"; return; }
    row.style.display = "flex";
    const def = brandsList.filter(function (b) { return b.is_default; })[0];
    sel.innerHTML =
      "<option value=''>No brand (org default)</option>" +
      brandsList.map(function (b) {
        return "<option value='" + b.id + "'>" + esc(b.name || "Brand") +
          (b.is_default ? " (default)" : "") + "</option>";
      }).join("");
    if (def) sel.value = String(def.id);
    populateTemplateSelect();
  }

  function populateTemplateSelect() {
    const sel = $("composer-template");
    if (!sel) return;
    const bid = $("composer-brand").value;
    const brand = brandsList.filter(function (b) { return String(b.id) === bid; })[0];
    const tmpls = (brand && brand.templates) || [];
    sel.innerHTML =
      "<option value=''>No template</option>" +
      tmpls.map(function (t) {
        return "<option value='" + esc(t.id) + "'>" + esc(t.name || "Template") + "</option>";
      }).join("");
    sel.disabled = !tmpls.length;
  }

  // ---- anthropic availability banner --------------------------------------
  async function checkAi() {
    try {
      const r = await fetch(API + "/api/branding");
      if (r.ok) {
        const b = await r.json();
        if (b && b.ai_configured === false) {
          $("ai-warn-msg").textContent =
            "The AI provider isn't configured yet, so new drafts can't be generated. Existing quotes still export.";
          $("ai-warn").style.display = "block";
        }
      }
    } catch (e) { /* non-fatal */ }
  }

  function wire() {
    $("new-quote-btn").addEventListener("click", openComposer);
    $("empty-new-btn").addEventListener("click", openComposer);
    $("composer-cancel").addEventListener("click", closeComposer);
    $("composer-send").addEventListener("click", composerSend);
    composerPicker = makeFilePicker("composer-attach-btn", "composer-files", "composer-file-list");
    $("ctx-add").addEventListener("click", addChip);
    $("ctx-type").addEventListener("change", function () { loadPicker("ctx-pick", $("ctx-type").value); });
    const brandSel = $("composer-brand");
    if (brandSel) brandSel.addEventListener("change", populateTemplateSelect);
    $("proposals-toggle").addEventListener("click", toggleDrawer);
    $("q-drawer-close").addEventListener("click", closeDrawer);
    $("q-drawer-backdrop").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDrawer(); });
    loadList();
    checkAi();
    loadBrands();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
