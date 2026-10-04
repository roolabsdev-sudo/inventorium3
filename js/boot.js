/**
 * Page boot: confirms the person is logged in (Netlify Identity), loads their data
 * from the cloud, checks they may open this page, switches the page to read-only
 * if they only have 'view' access, and only then starts the page's own script.
 *
 * Each page includes:
 *   <script src="js/boot.js" data-area="inventory" data-need="view" data-page="js/inventory.js"></script>
 */
(function () {
  "use strict";

  var tag = document.currentScript;
  var area = tag.getAttribute("data-area");
  var need = tag.getAttribute("data-need") || "view";
  var pageScript = tag.getAttribute("data-page");
  var WIDGET = "https://identity.netlify.com/v1/netlify-identity-widget.js";

  document.body.classList.add("booting");

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error("Couldn't load " + src)); };
      document.head.appendChild(s);
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function toLogin() {
    var next = location.pathname.split("/").pop() || "index.html";
    location.replace("login.html?next=" + encodeURIComponent(next));
  }

  function signOut() {
    try {
      var p = netlifyIdentity.logout();
      if (p && p.then) p.then(function () { location.href = "login.html"; });
      else setTimeout(function () { location.href = "login.html"; }, 300);
    } catch (e) { location.href = "login.html"; }
  }

  function fatal(title, message, opts) {
    opts = opts || {};
    document.body.classList.remove("booting");
    var main = document.querySelector(".main") || document.body;
    main.innerHTML =
      '<section class="module" style="max-width:520px;margin:48px auto;">' +
      '<div class="module-head"><h2>' + esc(title) + "</h2></div>" +
      '<div class="module-body"><p class="dim" style="margin-bottom:16px;">' + esc(message) + "</p>" +
      (opts.home ? '<a class="btn btn-ghost" href="' + esc(opts.home) + '" style="margin-right:8px;">Go to a page you can open</a>' : "") +
      '<button class="btn btn-primary" type="button" id="fatal-signout">Sign out</button></div></section>';
    var b = document.getElementById("fatal-signout");
    if (b) b.addEventListener("click", signOut);
  }

  window.Auth = { signOut: signOut };

  loadScript(WIDGET).then(function () {
    // Invite / password-reset / confirmation links land on whatever page the emailed link points at.
    if (/(invite|recovery|confirmation|email_change)_token=/.test(location.hash)) {
      location.replace("login.html" + location.hash);
      return new Promise(function () {});
    }
    netlifyIdentity.init();
    netlifyIdentity.on("logout", function () { location.href = "login.html"; });
    if (!netlifyIdentity.currentUser()) {
      toLogin();
      return new Promise(function () {});
    }
    return Store.load();
  }).then(function () {
    if (!Store.getMe()) return;

    if (!Store.can(area, "view")) {
      var home = Store.firstAllowedPage();
      if (home && home !== location.pathname.split("/").pop()) {
        location.replace(home);
      } else if (!home) {
        fatal("No access yet", "You're logged in as " + Store.getMe().name + ", but no pages have been turned on for your account. Ask an advisor to give you access on the Employees page.");
      } else {
        fatal("No access", "You don't have access to this page.", { home: home });
      }
      return;
    }
    if (need === "edit" && !Store.can(area, "edit")) {
      fatal("Edit access needed", "This page changes inventory, so it needs edit access. You currently have view-only access to Inventory.", { home: Store.firstAllowedPage() });
      return;
    }

    if (!Store.can(area, "edit")) document.body.classList.add("ro");
    return loadScript(pageScript).then(function () {
      document.body.classList.remove("booting");

      // Pick up other people's changes when someone comes back to a tab that's been idle.
      var hiddenAt = 0;
      document.addEventListener("visibilitychange", function () {
        if (document.hidden) { hiddenAt = Date.now(); return; }
        if (hiddenAt && Date.now() - hiddenAt > 120000 && !Store.hasPending() && !document.querySelector("dialog[open]")) {
          location.reload();
        }
      });
    });
  }).catch(function (err) {
    if (err && err.status === 401) { toLogin(); return; }
    // Logged in, but not on any venue's roster yet (or waiting for approval): onboarding page.
    if (err && (err.code === "needs_onboarding" || err.code === "pending")) { location.replace("welcome.html"); return; }
    var msg = (err && err.message) || "Something went wrong.";
    if (err && err.status === 403) fatal("Can't open the app", msg);
    else fatal("Couldn't load your data", msg + " Check your connection and try again.");
  });
})();
