/* Shared helper for the "Continue with Google" button on /login and /signup.
 * The OAuth round-trip is a top-level browser redirect (GET /api/auth/google/
 * start -> Google -> GET /api/auth/google/callback), so the backend can only
 * hand the result back via a URL — it uses the fragment (#google_token=... /
 * #google_error=...) specifically because a fragment is never sent to any
 * server in a later request, unlike a query string. This script reads it,
 * exchanges the token for the user object via /api/auth/me, and stores both
 * through window.Auth — exactly like a normal email/password login. */
(function () {
  "use strict";

  function consumeParam(name) {
    var re = new RegExp("(?:^|[#&])" + name + "=([^&]*)");
    var m = re.exec(window.location.hash);
    if (!m) return null;
    // Strip it from the URL immediately so a refresh or back-navigation
    // can't resubmit a one-time token.
    history.replaceState(null, "", window.location.pathname + window.location.search);
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }

  window.GoogleAuth = {
    consumeToken: function () { return consumeParam("google_token"); },
    consumeError: function () { return consumeParam("google_error"); },
    // Resolves true (and calls window.Auth.set) on success, false otherwise.
    finishLogin: function (token) {
      return fetch("/api/auth/me", { headers: { Authorization: "Bearer " + token } })
        .then(function (r) { if (!r.ok) throw new Error("Invalid token"); return r.json(); })
        .then(function (user) { window.Auth.set(token, user); return true; })
        .catch(function () { return false; });
    },
  };
})();
