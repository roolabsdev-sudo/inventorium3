/**
 * Welcome page: where someone lands after signing in when their email isn't on any venue's roster.
 *   needs_venue -> "Create your venue" form, or "Join with a code" to ask an existing venue
 *   pending     -> "Waiting for approval" (with the venue's name, and a way to withdraw)
 *   member      -> straight on to the app, unless they opened welcome.html?join=1 (from Settings) to swap a
 *                  venue they made by mistake for another one: then the join form, if the server says it's still empty
 * The server decides (GET /api/onboarding); this page only shows the result.
 */
(function () {
  "use strict";

  var FN = "/.netlify/functions/onboarding";
  var $ = function (id) { return document.getElementById(id); };
  var panels = ["w-loading", "w-create", "w-join", "w-keep", "w-pending", "w-fail"];
  // welcome.html?join=1: a member who made their venue by mistake, joining another venue instead.
  var replacing = /[?&]join=1(&|$)/.test(location.search);
  var swapName = "";
  var logo = null;

  function show(which) {
    panels.forEach(function (id) { $(id).hidden = id !== which; });
  }
  function toLogin() { location.replace("login.html?next=welcome.html"); }
  function toApp() { location.replace("index.html"); }
  function signOut() {
    try {
      var p = netlifyIdentity.logout();
      if (p && p.then) p.then(function () { location.href = "login.html"; });
      else setTimeout(function () { location.href = "login.html"; }, 300);
    } catch (e) { location.href = "login.html"; }
  }

  function call(method, body) {
    var user = netlifyIdentity.currentUser();
    if (!user) { toLogin(); return Promise.reject(new Error("Not logged in.")); }
    return user.jwt().then(function (token) {
      return fetch(FN, {
        method: method,
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    }).then(function (res) {
      return res.text().then(function (text) {
        var json = {};
        try { json = text ? JSON.parse(text) : {}; } catch (e) {}
        if (!res.ok) {
          var err = new Error(json.error || "Request failed (" + res.status + ")");
          err.status = res.status;
          throw err;
        }
        return json;
      });
    });
  }

  function check(note) {
    show("w-loading");
    call("GET").then(function (r) {
      if (r.state === "member") {
        if (!replacing) return toApp();
        if (!r.replaceable) return show("w-keep");
        swapName = r.venueName || "your venue";
        return openJoin();
      }
      if (r.state === "pending") {
        $("w-pending-venue").textContent = r.venueName || "a venue";
        return show("w-pending");
      }
      $("w-email").textContent = (netlifyIdentity.currentUser() || {}).email || "";
      show("w-create");
      fail(typeof note === "string" ? note : "");
      $("w-name").focus();
    }).catch(function (err) {
      if (err.status === 401) return toLogin();
      $("w-fail-note").textContent = err.message + " Check your connection and try again.";
      show("w-fail");
    });
  }

  /* ----- logo: shrink to a small PNG so it stays light to store and load ----- */
  function shrink(img) {
    var sizes = [256, 160, 96];
    for (var i = 0; i < sizes.length; i++) {
      var scale = Math.min(1, sizes[i] / Math.max(img.width, img.height));
      var c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      var url = c.toDataURL("image/png");
      if (url.length <= 300000) return url;
    }
    return null;
  }
  function drawLogo() {
    $("w-logo-preview").src = Branding.logoSrc({ logo: logo });
    $("w-logo-remove").hidden = !logo;
  }
  function fail(msg) { var e = $("w-error"); e.textContent = msg; e.hidden = !msg; }

  $("w-logo-pick").addEventListener("click", function () { $("w-logo-file").click(); });
  $("w-logo-remove").addEventListener("click", function () { logo = null; $("w-logo-file").value = ""; drawLogo(); });
  $("w-logo-file").addEventListener("change", function () {
    var file = this.files && this.files[0];
    if (!file) return;
    fail("");
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return fail("Choose a PNG, JPEG or WebP image.");
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var url = shrink(img);
        if (!url) return fail("That image is too large — try a smaller one.");
        logo = url; drawLogo();
      };
      img.onerror = function () { fail("Couldn't read that image."); };
      img.src = reader.result;
    };
    reader.onerror = function () { fail("Couldn't read that image."); };
    reader.readAsDataURL(file);
  });

  $("w-form").addEventListener("submit", function (e) {
    e.preventDefault();
    fail("");
    var btn = $("w-submit");
    btn.disabled = true; btn.textContent = "Creating…";
    call("POST", { name: $("w-name").value, subtitle: $("w-sub").value, logo: logo }).then(function () {
      btn.textContent = "Done — loading…";
      toApp();
    }).catch(function (err) {
      btn.disabled = false; btn.textContent = "Create venue";
      if (err.status === 401) return toLogin();
      if (err.status === 409) return check(err.message); // already a member / pending: show the right screen
      fail(err.message);
    });
  });

  /* ----- join an existing venue with a code ----- */
  function joinFail(msg) { var e = $("w-join-error"); e.textContent = msg; e.hidden = !msg; }

  function openJoin() {
    var u = netlifyIdentity.currentUser() || {};
    $("w-join-email").textContent = u.email || "";
    var typed = $("w-join-name");
    if (!typed.value) typed.value = (u.user_metadata && u.user_metadata.full_name) || "";
    joinFail("");
    $("w-replace-note").hidden = !swapName;
    $("w-replace-name").textContent = swapName;
    show("w-join");
    $("w-code").focus();
  }
  $("w-to-join").addEventListener("click", function () { swapName = ""; openJoin(); });
  $("w-join-back").addEventListener("click", function () {
    if (swapName) return toApp(); // keep the venue they made
    show("w-create"); $("w-name").focus();
  });

  $("w-join-form").addEventListener("submit", function (e) {
    e.preventDefault();
    joinFail("");
    var btn = $("w-join-submit");
    btn.disabled = true; btn.textContent = "Sending…";
    call("POST", { action: "join", code: $("w-code").value, name: $("w-join-name").value, replaceVenue: swapName ? true : undefined }).then(function () {
      btn.disabled = false; btn.textContent = "Ask to join";
      $("w-code").value = "";
      swapName = ""; replacing = false; // the old venue is gone: this is an ordinary waiting screen now
      check(); // shows the waiting screen
    }).catch(function (err) {
      btn.disabled = false; btn.textContent = "Ask to join";
      if (err.status === 401) return toLogin();
      if (err.status === 409) { btn.textContent = "Ask to join"; return check(err.message); } // already a member / waiting: show the right screen
      joinFail(err.message);
    });
  });

  $("w-cancel-request").addEventListener("click", function () {
    if (!confirm("Withdraw your request to join?")) return;
    call("POST", { action: "cancel" }).then(function () { check(); }).catch(function (err) {
      if (err.status === 401) return toLogin();
      $("w-fail-note").textContent = err.message + " Check your connection and try again.";
      show("w-fail");
    });
  });

  $("w-signout").addEventListener("click", signOut);
  $("w-recheck").addEventListener("click", function () { check(); });
  $("w-retry").addEventListener("click", function () { check(); });

  /* ----- start ----- */
  netlifyIdentity.on("logout", function () { location.href = "login.html"; });
  if (/(invite|recovery|confirmation|email_change)_token=/.test(location.hash)) {
    location.replace("login.html" + location.hash);
  } else {
    netlifyIdentity.init();
    if (!netlifyIdentity.currentUser()) toLogin(); else check();
  }
})();
