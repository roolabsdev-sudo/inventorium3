/**
 * Join requests page: make join codes, and approve or decline the people who used them.
 * The server decides everything (see netlify/functions/join-codes.js and join-requests.js);
 * this page only shows the result and sends the admin's choices.
 */
(function () {
  "use strict";

  UI.buildRail("requests.html");

  var $ = function (id) { return document.getElementById(id); };
  var esc = UI.esc;
  var codes = [];
  var requests = [];

  function roleName(id) {
    var r = id ? Store.getRole(id) : null;
    return r ? r.name : "";
  }
  function levelWord(v) { return v === "edit" ? "edit" : "view"; }
  function access(o) {
    var parts = [];
    if (o.permInventory !== "none") parts.push("Inventory " + levelWord(o.permInventory));
    if (o.permCallList !== "none") parts.push("Call list " + levelWord(o.permCallList));
    if (o.permEmployees !== "none") parts.push("Employees " + levelWord(o.permEmployees));
    if (o.permSettings !== "none") parts.push("Settings " + levelWord(o.permSettings));
    return parts.length ? parts.join(", ") : "No page access";
  }
  function gives(o) {
    var role = roleName(o.roleId);
    return '<span class="item-name">' + esc(role || "No role") + '</span><span class="item-loc">' + esc(access(o)) + "</span>";
  }
  function when(iso) {
    var d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  function fail(err) {
    if (err && err.status === 401) { location.replace("login.html?next=requests.html"); return; }
    UI.toast((err && err.message) || "Something went wrong.", "error");
  }

  /* ---------- requests ---------- */

  function renderRequests() {
    $("req-count").textContent = requests.length + " waiting";
    if (!requests.length) {
      $("req-rows").innerHTML = '<tr><td colspan="4" class="dim" style="padding:28px 16px">Nobody is waiting. When someone uses one of your codes, they appear here.</td></tr>';
      return;
    }
    $("req-rows").innerHTML = requests.map(function (r) {
      return "<tr>" +
        '<td><span class="item-name">' + esc(r.name || r.email) + '</span><span class="item-loc">' + esc(r.email) + "</span></td>" +
        "<td>" + gives(r) + "</td>" +
        '<td class="dim">' + esc(UI.timeAgo(new Date(r.requestedAt).getTime())) + "</td>" +
        '<td><div class="row-actions" style="gap:8px;">' +
        '<button class="btn btn-primary" type="button" data-approve="' + esc(r.id) + '" style="min-height:36px;padding:0 14px;">Approve</button>' +
        '<button class="btn btn-ghost" type="button" data-decline="' + esc(r.id) + '" style="min-height:36px;padding:0 14px;">Decline</button>' +
        "</div></td></tr>";
    }).join("");
  }

  function decide(id, action, btn) {
    var r = requests.find(function (x) { return String(x.id) === String(id); });
    if (!r) return;
    if (action === "decline" && !confirm("Decline " + (r.name || r.email) + "? They'll be sent back to the sign-up page and can ask again.")) return;
    var row = btn.closest("tr");
    row.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
    Store.call("POST", "join-requests", "", { id: r.id, action: action }).then(function () {
      requests = requests.filter(function (x) { return x !== r; });
      renderRequests();
      UI.toast(action === "approve" ? (r.name || r.email) + " can now sign in" : "Declined");
      if (action === "approve") loadCodes(); // their place on a code now counts as used
    }).catch(function (err) {
      fail(err);
      loadRequests(); // it may have been handled elsewhere: show what's true now
    });
  }

  $("req-rows").addEventListener("click", function (e) {
    var a = e.target.closest("[data-approve]");
    if (a) return decide(a.getAttribute("data-approve"), "approve", a);
    var d = e.target.closest("[data-decline]");
    if (d) decide(d.getAttribute("data-decline"), "decline", d);
  });

  function loadRequests() {
    return Store.call("GET", "join-requests").then(function (r) { requests = r.requests || []; renderRequests(); }).catch(fail);
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
      $("code-rows").innerHTML = '<tr><td colspan="5" class="dim" style="padding:28px 16px">No codes yet. Make one to invite people.</td></tr>';
      return;
    }
    $("code-rows").innerHTML = codes.map(function (c) {
      return "<tr>" +
        '<td><span class="mono item-name" style="letter-spacing:.08em;">' + esc(c.code) + "</span>" + (STATE[c.state] || "") + "</td>" +
        "<td>" + gives(c) + "</td>" +
        '<td class="mono">' + c.uses + (c.maxUses ? " / " + c.maxUses : "") + "</td>" +
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
    if (!confirm("Turn off " + code.code + "? Nobody new can use it. Requests already made with it stay on the list.")) return;
    Store.call("DELETE", "join-codes", "id=" + encodeURIComponent(code.id)).then(function () {
      codes = codes.filter(function (x) { return x !== code; });
      renderCodes();
      UI.toast("Turned off " + code.code);
    }).catch(function (err) { fail(err); loadCodes(); });
  });

  function loadCodes() {
    return Store.call("GET", "join-codes").then(function (r) { codes = r.codes || []; renderCodes(); }).catch(fail);
  }

  /* ---------- new code dialog ---------- */

  var dialog = $("code-dialog");

  function fillRoles() {
    var roles = Store.getRoles();
    $("c-role").innerHTML = '<option value="">No role</option>' + roles.map(function (r) {
      return '<option value="' + esc(r.id) + '">' + esc(r.name) + "</option>";
    }).join("");
  }
  function warn() {
    $("c-warn").hidden = $("c-perm-employees").value === "none" && $("c-perm-settings").value === "none";
  }
  $("c-perm-employees").addEventListener("change", warn);
  $("c-perm-settings").addEventListener("change", warn);

  $("new-code-btn").addEventListener("click", function () {
    fillRoles(); warn();
    dialog.showModal();
  });
  $("c-cancel").addEventListener("click", function () { dialog.close(); });

  $("code-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var btn = $("c-save");
    btn.disabled = true; btn.textContent = "Creating…";
    Store.call("POST", "join-codes", "", {
      roleId: $("c-role").value || null,
      permInventory: $("c-perm-inventory").value, permCallList: $("c-perm-call").value,
      permEmployees: $("c-perm-employees").value, permSettings: $("c-perm-settings").value,
      days: $("c-days").value, maxUses: $("c-max").value
    }).then(function (r) {
      dialog.close();
      codes.unshift(r.code);
      renderCodes();
      UI.toast("New code " + r.code.code);
    }).catch(fail).then(function () {
      btn.disabled = false; btn.textContent = "Create code";
    });
  });

  renderRequests();
  renderCodes();
  loadRequests();
  loadCodes();
})();
