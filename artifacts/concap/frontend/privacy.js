/* Consent & Privacy page. The org-level consent profile (score gauge,
 * statistics, badges, trends, tips) — split out of the Profile page into its
 * own Settings section. */
(function () {
  "use strict";

  var BADGE_ICON = {
    privacy_champion: "♛", // ♛
    community_trust_builder: "⚘", // ⚘
    ethical_communicator: "⚖", // ⚖
  };

  var state = { profile: null, trendMode: "weekly" };

  function show(id) { document.getElementById(id).style.display = ""; }
  function hide(id) { document.getElementById(id).style.display = "none"; }
  function setText(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }

  function renderGauge(score) {
    var num = document.getElementById("score-num");
    var arc = document.getElementById("gauge-arc");
    var C = 2 * Math.PI * 86; // circumference for r=86
    arc.setAttribute("stroke-dasharray", String(C));
    var pct = Math.max(0, Math.min(100, score)) / 100;
    arc.setAttribute("stroke-dashoffset", String(C * (1 - pct)));
    var color = score >= 90 ? "#22c55e" : score >= 70 ? "var(--accent)" : score >= 50 ? "#f59e0b" : "#ef4444";
    arc.setAttribute("stroke", color);
    var target = Math.round(score), cur = 0;
    var step = Math.max(1, Math.round(target / 24));
    var timer = setInterval(function () {
      cur += step;
      if (cur >= target) { cur = target; clearInterval(timer); }
      num.textContent = cur;
    }, 18);
  }

  function renderTrust(rating, total) {
    var badge = document.getElementById("trust-badge");
    badge.textContent = rating;
    badge.className = "trust-badge trust-" + rating.replace(/\s+/g, "-");
    setText("trust-total", total);
  }

  function renderStats(s) {
    setText("st-total", s.total_recorded);
    setText("st-requested", s.consent_requested);
    setText("st-confirmed", s.consent_confirmed);
    setText("st-missing", s.consent_missing);
    setText("st-declined", s.consent_declined);
    setText("st-explained", s.privacy_explained);
  }

  function renderBadges(badges) {
    var grid = document.getElementById("badge-grid");
    grid.innerHTML = "";
    badges.forEach(function (b) {
      var card = document.createElement("div");
      card.className = "badge-card " + (b.earned ? "earned" : "locked");
      card.innerHTML =
        '<div class="badge-medal">' + (BADGE_ICON[b.key] || "★") + "</div>" +
        "<div><div class=\"badge-name\">" + b.name + "</div>" +
        '<div class="badge-desc">' + b.description + "</div>" +
        '<div class="badge-status">' + (b.earned ? "Earned" : "Locked") + "</div></div>";
      grid.appendChild(card);
    });
  }

  function shortLabel(period) {
    if (period.indexOf("W") !== -1) return period.split("-")[1];
    var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    var m = parseInt(period.split("-")[1], 10);
    return months[m - 1] || period;
  }

  function renderTrend() {
    var data = state.profile.trends[state.trendMode] || [];
    var wrap = document.getElementById("trend-bars");
    wrap.innerHTML = "";
    if (!data.length) { wrap.innerHTML = '<div class="muted">No data yet.</div>'; return; }
    data.forEach(function (d) {
      var col = document.createElement("div");
      col.className = "trend-col";
      var h = Math.max(3, Math.round((d.rate / 100) * 110));
      var hasData = d.total > 0;
      col.innerHTML =
        '<div class="t-rate">' + (hasData ? Math.round(d.rate) + "%" : "—") + "</div>" +
        '<div class="trend-fill" style="height:' + (hasData ? h : 3) + "px;" + (hasData ? "" : "opacity:.3;") + '"></div>' +
        '<div class="t-label">' + shortLabel(d.period) + "</div>";
      col.title = d.consent_requests + " of " + d.total + " requested consent";
      wrap.appendChild(col);
    });
  }

  function renderNotifications(list) {
    var ul = document.getElementById("notif-list");
    ul.innerHTML = "";
    if (!list || !list.length) { ul.innerHTML = '<li class="muted">No tips right now.</li>'; return; }
    list.forEach(function (msg) {
      var li = document.createElement("li");
      li.innerHTML = '<span class="n-ico">✦</span><span>' + msg + "</span>";
      ul.appendChild(li);
    });
  }

  function renderPrivacy() {
    var p = state.profile;
    renderGauge(p.privacy_score);
    renderTrust(p.trust_rating, p.stats.total_recorded);
    renderStats(p.stats);
    renderBadges(p.badges);
    renderTrend();
    renderNotifications(p.notifications);
    hide("loading");
    show("profile");
  }

  function wireToggle() {
    var w = document.getElementById("seg-weekly");
    var m = document.getElementById("seg-monthly");
    w.addEventListener("click", function () {
      state.trendMode = "weekly"; w.classList.add("active"); m.classList.remove("active"); renderTrend();
    });
    m.addEventListener("click", function () {
      state.trendMode = "monthly"; m.classList.add("active"); w.classList.remove("active"); renderTrend();
    });
  }

  function loadPrivacy() {
    fetch("/api/privacy/profile")
      .then(function (r) {
        if (!r.ok) throw new Error("Failed to load (" + r.status + ")");
        return r.json();
      })
      .then(function (data) {
        state.profile = data;
        wireToggle();
        renderPrivacy();
      })
      .catch(function (e) {
        hide("loading");
        show("error");
        setText("error-msg", e.message || "Could not load your Consent & Privacy profile.");
      });
  }

  function init() { loadPrivacy(); }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
