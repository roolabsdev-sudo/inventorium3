/**
 * Scanners page: make scanner codes, and sign scanner devices out.
 * The server decides everything (see netlify/functions/scanner-codes.js); this page only shows the result.
 */
(function () {
  "use strict";

  UI.buildRail("scanners.html");

  var $ = function (id) { return document.getElementById(id); };
  var esc = UI.esc;
  var codes = [];
  var devices = [];

  $("login-url").textContent = location.origin + "/login.html?scanner=1";

  function when(iso) {
    var d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function fail(err) {
    if (err && err.status === 401) { location.replace("login.html?next=scanners.html"); return; }
    UI.toast((err && err.message) || "Something went wrong.", "error");
  }

  /* ---------- codes ---------- */

  var STATE = {
    active: '<span class="badge badge-ok">Active</span>',
    expired: '<span class="badge badge-maint">Expired</span>',
    used_up: '<span class="badge badge-maint">Used up</span>'
  };

  function renderCodes() {
    $("code-count").textContent = codes.length + (codes.length === 1 ? " code" : " codes");
    if (!codes.length) {
      $("code-rows").innerHTML = '<tr><td colspan="4" class="dim" style="padding:28px 16px">No scanner codes yet. Make one to set up a scanner.</td></tr>';
      return;
    }
    $("code-rows").innerHTML = codes.map(function (c) {
      return "<tr>" +
        '<td><span class="mono item-name" style="letter-spacing:.08em;">' + esc(c.code) + "</span>" +
        (c.label ? '<span class="item-loc">' + esc(c.label) + "</span>" : "") + (STATE[c.state] || "") + "</td>" +
        '<td class="mono">' + c.uses + " / " + c.maxDevices + "</td>" +
        '<td class="dim">' + esc(when(c.expiresAt)) + "</td>" +
        '<td><div class="row-actions">' +
        '<button class="icon-btn" data-copy="' + esc(c.code) + '" title="Copy code" aria-label="Copy code ' + esc(c.code) + '">' +
        '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg></button>' +
        '<button class="icon-btn icon-btn-danger" data-off="' + esc(c.id) + '" title="Turn off" aria-label="Turn off code ' + esc(c.code) + '">' +
        '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button>' +
        "</div></td></tr>";
    }).join("");
  }

  function copy(text) {
    function done() { UI.toast("Copied " + text); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { UI.toast("Couldn't copy: select the code and copy it by hand", "warn"); });
      return;
    }
    var t = document.createElement("textarea");
    t.value = text; t.style.position = "fixed"; t.style.opacity = "0";
    document.body.appendChild(t); t.select();
    try { document.execCommand("copy"); done(); } catch (e) { UI.toast("Couldn't copy: select the code and copy it by hand", "warn"); }
    t.remove();
  }

  $("code-rows").addEventListener("click", function (e) {
    var c = e.target.closest("[data-copy]");
    if (c) return copy(c.getAttribute("data-copy"));
    var o = e.target.closest("[data-off]");
    if (!o) return;
    var code = codes.find(function (x) { return String(x.id) === o.getAttribute("data-off"); });
    if (!code) return;
    if (!confirm("Turn off " + code.code + "? No new device can use it. Scanners already signed in with it keep working until you sign them out.")) return;
    Store.call("DELETE", "scanner-codes", "id=" + encodeURIComponent(code.id)).then(function () {
      codes = codes.filter(function (x) { return x !== code; });
      renderCodes();
      UI.toast("Turned off " + code.code);
    }).catch(function (err) { fail(err); load(); });
  });

  /* ---------- signed-in devices ---------- */

  function renderDevices() {
    $("dev-count").textContent = devices.length + (devices.length === 1 ? " scanner" : " scanners");
    if (!devices.length) {
      $("dev-rows").innerHTML = '<tr><td colspan="4" class="dim" style="padding:28px 16px">No scanners are signed in.</td></tr>';
      return;
    }
    $("dev-rows").innerHTML = devices.map(function (d) {
      return "<tr>" +
        '<td><span class="item-name">' + esc(d.label || "Scanner") + "</span></td>" +
        '<td class="dim">' + esc(when(d.createdAt)) + "</td>" +
        '<td class="dim">' + (d.lastSeenAt ? esc(UI.timeAgo(new Date(d.lastSeenAt).getTime())) : "—") + "</td>" +
        '<td><div class="row-actions">' +
        '<button class="btn btn-ghost" type="button" data-signout="' + esc(d.id) + '" style="min-height:36px;padding:0 14px;">Sign out</button>' +
        "</div></td></tr>";
    }).join("");
  }

  $("dev-rows").addEventListener("click", function (e) {
    var b = e.target.closest("[data-signout]");
    if (!b) return;
    var dev = devices.find(function (x) { return String(x.id) === b.getAttribute("data-signout"); });
    if (!dev) return;
    if (!confirm("Sign out " + (dev.label || "this scanner") + "? It stops working right away and needs a new scanner code to be used again.")) return;
    b.disabled = true;
    Store.call("DELETE", "scanner-codes", "device=" + encodeURIComponent(dev.id)).then(function () {
      devices = devices.filter(function (x) { return x !== dev; });
      renderDevices();
      UI.toast("Signed out " + (dev.label || "scanner"));
    }).catch(function (err) { fail(err); load(); });
  });

  function load() {
    return Store.call("GET", "scanner-codes").then(function (r) {
      codes = r.codes || []; devices = r.devices || [];
      renderCodes(); renderDevices();
    }).catch(fail);
  }

  /* ---------- new code dialog ---------- */

  var dialog = $("code-dialog");
  $("new-code-btn").addEventListener("click", function () {
    $("c-label").value = ""; $("c-max").value = "1"; $("c-hours").value = "24";
    dialog.showModal();
  });
  $("c-cancel").addEventListener("click", function () { dialog.close(); });

  $("code-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var btn = $("c-save");
    btn.disabled = true; btn.textContent = "Creating…";
    Store.call("POST", "scanner-codes", "", {
      label: $("c-label").value, hours: $("c-hours").value, maxDevices: $("c-max").value
    }).then(function (r) {
      dialog.close();
      codes.unshift(r.code);
      renderCodes();
      UI.toast("New code " + r.code.code);
    }).catch(fail).then(function () {
      btn.disabled = false; btn.textContent = "Create code";
    });
  });

  renderCodes();
  renderDevices();
  load();
})();
