/* Auth layer — loaded as a CLASSIC script before any module/page script so
 * it can patch window.fetch globally before the first API call fires.
 *
 * Responsibilities:
 *   1. Token storage (localStorage).
 *   2. Patch fetch(): attach Authorization for same-origin /api/* calls
 *      (except /api/auth/*), and on a 401 from an interactive call, bounce
 *      to /login. The offline-queue path (/api/captures) is exempt from the
 *      auto-redirect so a background drain with an expired token just stays
 *      queued instead of yanking the rep to a login screen.
 *   3. Page guard: protected pages redirect to /login when there's no
 *      (locally non-expired) token.
 *   4. Sidebar: fill in the signed-in email and wire the logout button.
 */
(function () {
  "use strict";

  var TOKEN_KEY = "booth_auth_token";
  var USER_KEY = "booth_auth_user";
  var PUBLIC_PATHS = ["/login", "/signup"];
  // /change-password needs a token but must be reachable while
  // must_change_password is still true, so it's neither fully public nor
  // subject to the must-change redirect (handled explicitly below).

  var Auth = {
    getToken: function () {
      try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
    },
    getUser: function () {
      try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); } catch (e) { return null; }
    },
    set: function (token, user) {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user || null));
    },
    clear: function () {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    },
    // Decode the JWT payload (no signature check — server is the real gate).
    payload: function () {
      var t = this.getToken();
      if (!t) return null;
      try {
        var p = t.split(".")[1];
        p = p.replace(/-/g, "+").replace(/_/g, "/");
        while (p.length % 4) p += "=";
        return JSON.parse(atob(p));
      } catch (e) { return null; }
    },
    isExpired: function () {
      var pl = this.payload();
      if (!pl || !pl.exp) return true;
      return pl.exp * 1000 < Date.now();
    },
    isAuthed: function () {
      return !!this.getToken() && !this.isExpired();
    },
    logout: function () {
      this.clear();
      window.location.href = "/login";
    },
  };
  window.Auth = Auth;

  // --- fetch patch --------------------------------------------------------
  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    init = init || {};
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var isApi = url.indexOf("/api/") !== -1;
    var isAuthApi = url.indexOf("/api/auth/") !== -1;

    if (isApi && !isAuthApi) {
      var token = Auth.getToken();
      if (token) {
        var headers = new Headers(init.headers || (typeof input !== "string" && input.headers) || {});
        if (!headers.has("Authorization")) headers.set("Authorization", "Bearer " + token);
        init = Object.assign({}, init, { headers: headers });
      }
    }

    return nativeFetch(input, init).then(function (resp) {
      if (resp.status === 401 && isApi && !isAuthApi) {
        // The offline queue handles its own 401s (keeps the capture pending);
        // don't hijack navigation out from under a background drain.
        var isQueuePath = url.indexOf("/api/captures") !== -1;
        if (!isQueuePath && PUBLIC_PATHS.indexOf(window.location.pathname) === -1) {
          Auth.clear();
          window.location.href = "/login";
        }
      }
      return resp;
    });
  };

  // --- page guard ---------------------------------------------------------
  var path = window.location.pathname;
  var isPublicPage = PUBLIC_PATHS.indexOf(path) !== -1;
  if (!isPublicPage && !Auth.isAuthed()) {
    window.location.replace("/login");
    return; // stop further script work on this page
  }

  // Force a password change for invited users before they can use the app.
  var u = Auth.getUser();
  if (
    !isPublicPage &&
    Auth.isAuthed() &&
    u && u.must_change_password &&
    path !== "/change-password"
  ) {
    window.location.replace("/change-password");
    return;
  }

  // --- sidebar wiring (runs after DOM is ready) ---------------------------
  function wireSidebar() {
    var user = Auth.getUser();
    var emailEl = document.getElementById("auth-email");
    if (emailEl && user && user.email) emailEl.textContent = user.email;

    // Org name in the footer status row (if the slot exists).
    var orgEl = document.getElementById("org-name");
    if (orgEl && user && user.organization) orgEl.textContent = user.organization.name;
    var brandSub = document.getElementById("brand-subtitle");
    if (brandSub && user && user.organization) brandSub.textContent = user.organization.name;

    // Reveal the Members nav only for owner/admin.
    if (user && (user.role === "owner" || user.role === "admin")) {
      ["org-section", "nav-admin", "nav-members"].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.classList.remove("hidden");
      });
    }

    var logoutBtn = document.getElementById("auth-logout");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", function (e) {
        e.preventDefault();
        Auth.logout();
      });
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireSidebar);
  } else {
    wireSidebar();
  }
})();
