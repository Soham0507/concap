/* App navigation + theme layer — loaded as a CLASSIC script in <head> after
 * auth.js on every authenticated (sidebar) page.
 *
 * Responsibilities:
 *   1. Apply the saved color theme before first paint (no flash).
 *   2. Inject a fixed mobile top bar (hamburger + logo + theme toggle) and a
 *      backdrop so the persistent desktop sidebar becomes an off-canvas drawer
 *      on small screens.
 *   3. Inject a theme toggle into the desktop sidebar footer.
 *   4. Wire the drawer (open/close) and theme switching + persistence.
 *
 * Default theme is dark (matches the marketing landing page); the only other
 * value is "light", applied via the [data-theme="light"] attribute.
 */
(function () {
  "use strict";

  var THEME_KEY = "concap_theme";

  function savedTheme() {
    try {
      return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
    } catch (e) {
      return "dark";
    }
  }

  // --- pre-paint: apply theme immediately -------------------------------
  function applyTheme(theme) {
    if (theme === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme"); // default = dark
    }
  }
  applyTheme(savedTheme());

  // --- toggle button rendering ------------------------------------------
  function refreshToggles(theme) {
    var toggles = document.querySelectorAll("[data-theme-toggle]");
    var isDark = theme !== "light";
    for (var i = 0; i < toggles.length; i++) {
      var btn = toggles[i];
      var icon = isDark ? "\u2600" : "\u263E"; // ☀ when dark / ☾ when light
      if (btn.hasAttribute("data-labelled")) {
        btn.textContent = icon + "  " + (isDark ? "Light mode" : "Dark mode");
      } else {
        btn.textContent = icon;
      }
      btn.setAttribute(
        "aria-label",
        isDark ? "Switch to light theme" : "Switch to dark theme",
      );
    }
  }

  function setTheme(theme) {
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (e) {}
    refreshToggles(theme);
  }

  function toggleTheme() {
    setTheme(savedTheme() === "light" ? "dark" : "light");
  }

  // --- drawer state ------------------------------------------------------
  function syncBurger(open) {
    var burger = document.querySelector(".mt-burger");
    if (burger) burger.setAttribute("aria-expanded", open ? "true" : "false");
  }
  function openDrawer() {
    document.body.classList.add("nav-open");
    syncBurger(true);
  }
  function closeDrawer() {
    document.body.classList.remove("nav-open");
    syncBurger(false);
  }

  // --- Conversations nav link -------------------------------------------
  // The per-page sidebars are hardcoded and inconsistent (some omit the
  // Conversations link entirely), so inject it here to guarantee it appears on
  // every authenticated page in a STABLE position. Always anchor to Dashboard
  // (present in the Insights section on every page) so Conversations — and the
  // Meetings link injected after it — never jump between sections from page to
  // page. Fall back to before the footer only if Dashboard is somehow absent.
  function ensureConversationsNav(sidebar) {
    if (sidebar.querySelector('a.nav-item[href="/conversations"]')) return;
    var link = document.createElement("a");
    link.className = "nav-item";
    link.href = "/conversations";
    link.innerHTML = '<span class="icon">\u25A4</span> Conversations';
    if (window.location.pathname === "/conversations") {
      link.classList.add("active");
    }
    var anchor = sidebar.querySelector('a.nav-item[href="/dashboard"]');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(link, anchor.nextSibling);
    } else {
      var footer = sidebar.querySelector(".footer");
      if (footer) sidebar.insertBefore(link, footer);
      else sidebar.appendChild(link);
    }
  }

  // --- Multi-conversation (long-capture) nav link -----------------------
  // The /long-capture page lets a user upload one long recording and split
  // it into many conversations. Its link was historically commented out of
  // every page sidebar, so inject it here (renamed "Multi-conversation") to
  // guarantee it appears app-wide. Anchored right after Conversations.
  function ensureLongCaptureNav(sidebar) {
    if (sidebar.querySelector('a.nav-item[href="/long-capture"]')) return;
    var link = document.createElement("a");
    link.className = "nav-item";
    link.href = "/long-capture";
    link.innerHTML = '<span class="icon">\u29C9</span> Multi-conversation<span class="nav-beta">beta</span>';
    if (window.location.pathname === "/long-capture") {
      link.classList.add("active");
    }
    var anchor =
      sidebar.querySelector('a.nav-item[href="/conversations"]') ||
      sidebar.querySelector('a.nav-item[href="/dashboard"]');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(link, anchor.nextSibling);
    } else {
      var footer = sidebar.querySelector(".footer");
      if (footer) sidebar.insertBefore(link, footer);
      else sidebar.appendChild(link);
    }
  }

  // --- Meeting Intelligence nav link ------------------------------------
  // Same rationale as Conversations: inject here so it shows on every app
  // page. Placed right after Conversations when present, else after
  // Dashboard, else before the footer.
  function ensureMeetingsNav(sidebar) {
    if (
      sidebar.querySelector('a.nav-item[href="/meetings"]') ||
      sidebar.querySelector('a.nav-item[href="/imported-meetings"]')
    )
      return;
    var link = document.createElement("a");
    link.className = "nav-item";
    link.href = "/all-meetings";
    link.innerHTML = '<span class="icon">\u25F0</span> Meetings<span class="nav-beta">beta</span>';
    if (
      window.location.pathname === "/meetings" ||
      window.location.pathname === "/imported-meetings" ||
      window.location.pathname === "/all-meetings"
    ) {
      link.classList.add("active");
    }
    var anchor =
      sidebar.querySelector('a.nav-item[href="/conversations"]') ||
      sidebar.querySelector('a.nav-item[href="/dashboard"]');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(link, anchor.nextSibling);
    } else {
      var footer = sidebar.querySelector(".footer");
      if (footer) sidebar.insertBefore(link, footer);
      else sidebar.appendChild(link);
    }
  }

  // --- Quote agent nav link ---------------------------------------------
  // Placed right after Meetings (then Conversations, then Dashboard) so the
  // Insights group stays stable from page to page.
  function ensureQuotesNav(sidebar) {
    if (sidebar.querySelector('a.nav-item[href="/quotes"]')) return;
    var link = document.createElement("a");
    link.className = "nav-item";
    link.href = "/quotes";
    link.innerHTML = '<span class="icon">\u25C8</span> Quote agent<span class="nav-beta">beta</span>';
    if (window.location.pathname === "/quotes") {
      link.classList.add("active");
    }
    var anchor =
      sidebar.querySelector('a.nav-item[href="/meetings"]') ||
      sidebar.querySelector('a.nav-item[href="/conversations"]') ||
      sidebar.querySelector('a.nav-item[href="/dashboard"]');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(link, anchor.nextSibling);
    } else {
      var footer = sidebar.querySelector(".footer");
      if (footer) sidebar.insertBefore(link, footer);
      else sidebar.appendChild(link);
    }
  }

  // --- Branding (Settings) nav link -------------------------------------
  // Anchored after Integrations (the other Settings item) so it lives in the
  // Settings group; falls back to before the footer.
  function ensureBrandingNav(sidebar) {
    if (sidebar.querySelector('a.nav-item[href="/branding"]')) return;
    var link = document.createElement("a");
    link.className = "nav-item";
    link.href = "/branding";
    link.innerHTML = '<span class="icon">\u25D1</span> Branding';
    if (window.location.pathname === "/branding") {
      link.classList.add("active");
    }
    var anchor = sidebar.querySelector('a.nav-item[href="/integrations"]');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(link, anchor.nextSibling);
    } else {
      var footer = sidebar.querySelector(".footer");
      if (footer) sidebar.insertBefore(link, footer);
      else sidebar.appendChild(link);
    }
  }

  // --- Brands (Settings) nav link ---------------------------------------
  // Multi-brand manager. Anchored after Branding (then Integrations) so it
  // lives in the Settings group; falls back to before the footer.
  function ensureBrandsNav(sidebar) {
    if (sidebar.querySelector('a.nav-item[href="/brands"]')) return;
    var link = document.createElement("a");
    link.className = "nav-item";
    link.href = "/brands";
    link.innerHTML = '<span class="icon">\u25C9</span> Branding';
    if (window.location.pathname === "/brands") {
      link.classList.add("active");
    }
    var anchor =
      sidebar.querySelector('a.nav-item[href="/branding"]') ||
      sidebar.querySelector('a.nav-item[href="/integrations"]');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(link, anchor.nextSibling);
    } else {
      var footer = sidebar.querySelector(".footer");
      if (footer) sidebar.insertBefore(link, footer);
      else sidebar.appendChild(link);
    }
  }

  // --- Profile (Settings) nav link --------------------------------------
  // Holds the user's own account details and voice identification profile.
  // Anchored after Branding (then Integrations) so it lives in the Settings
  // group; falls back to before the footer.
  function ensureProfileNav(sidebar) {
    if (sidebar.querySelector('a.nav-item[href="/profile"]')) return;
    var link = document.createElement("a");
    link.className = "nav-item";
    link.href = "/profile";
    link.innerHTML = '<span class="icon">\u25CC</span> Profile';
    if (window.location.pathname === "/profile") {
      link.classList.add("active");
    }
    var anchor =
      sidebar.querySelector('a.nav-item[href="/branding"]') ||
      sidebar.querySelector('a.nav-item[href="/integrations"]');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(link, anchor.nextSibling);
    } else {
      var footer = sidebar.querySelector(".footer");
      if (footer) sidebar.insertBefore(link, footer);
      else sidebar.appendChild(link);
    }
  }

  // --- Consent & Privacy (Settings) nav link ------------------------------
  // The org's consent/privacy dashboard \u2014 split out of Profile into its own
  // Settings page. Anchored right after Profile; falls back to before the
  // footer. Also marked active on the legacy /privacy URL it already owns.
  function ensurePrivacyNav(sidebar) {
    if (sidebar.querySelector('a.nav-item[href="/privacy"]')) return;
    var link = document.createElement("a");
    link.className = "nav-item";
    link.href = "/privacy";
    link.innerHTML = '<span class="icon">\u25D2</span> Consent &amp; Privacy';
    if (window.location.pathname === "/privacy") {
      link.classList.add("active");
    }
    var anchor = sidebar.querySelector('a.nav-item[href="/profile"]');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(link, anchor.nextSibling);
    } else {
      var footer = sidebar.querySelector(".footer");
      if (footer) sidebar.insertBefore(link, footer);
      else sidebar.appendChild(link);
    }
  }

  // --- DOM injection -----------------------------------------------------
  function build() {
    var sidebar = document.querySelector(".sidebar");
    if (!sidebar) return; // not an app shell page
    if (!sidebar.id) sidebar.id = "app-sidebar";

    ensureConversationsNav(sidebar);
    ensureMeetingsNav(sidebar);
    ensureQuotesNav(sidebar);
    // ensureBrandingNav(sidebar);
    ensureBrandsNav(sidebar);
    ensureProfileNav(sidebar);
    ensurePrivacyNav(sidebar);
    // Called last so it lands directly after Conversations, ahead of the
    // Meetings/Quotes links already inserted there.
    ensureLongCaptureNav(sidebar);

    // Mobile top bar.
    if (!document.querySelector(".mobile-topbar")) {
      var bar = document.createElement("header");
      bar.className = "mobile-topbar";
      bar.innerHTML =
        '<button class="mt-burger" type="button" aria-label="Open menu" aria-controls="app-sidebar" aria-expanded="false">\u2630</button>' +
        '<div class="mt-logo"><div class="concap-logo">' +
        '<div class="concap-logo-mark"></div>Concap AI</div></div>' +
        '<button class="theme-toggle" type="button" data-theme-toggle></button>';
      document.body.insertBefore(bar, document.body.firstChild);

      bar.querySelector(".mt-burger").addEventListener("click", function (e) {
        e.stopPropagation();
        if (document.body.classList.contains("nav-open")) closeDrawer();
        else openDrawer();
      });
    }

    // Backdrop.
    if (!document.querySelector(".nav-backdrop")) {
      var backdrop = document.createElement("div");
      backdrop.className = "nav-backdrop";
      document.body.appendChild(backdrop);
      backdrop.addEventListener("click", closeDrawer);
    }

    // Desktop theme toggle in the sidebar footer.
    var footer = sidebar.querySelector(".footer");
    if (footer && !footer.querySelector("[data-theme-toggle]")) {
      var deskToggle = document.createElement("button");
      deskToggle.type = "button";
      deskToggle.className = "theme-toggle";
      deskToggle.setAttribute("data-theme-toggle", "");
      deskToggle.setAttribute("data-labelled", "");
      footer.appendChild(deskToggle);
    }

    // Wire every toggle.
    var toggles = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < toggles.length; i++) {
      toggles[i].addEventListener("click", function (e) {
        e.preventDefault();
        toggleTheme();
      });
    }

    // Close the drawer when a nav link is tapped (navigation reloads anyway,
    // but this keeps it tidy for same-page anchors) and on Escape.
    var items = sidebar.querySelectorAll("a.nav-item");
    for (var j = 0; j < items.length; j++) {
      items[j].addEventListener("click", closeDrawer);
    }
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeDrawer();
    });

    refreshToggles(savedTheme());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }
})();
