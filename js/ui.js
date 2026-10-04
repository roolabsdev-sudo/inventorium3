(function (global) {
  "use strict";

  var NAV_ITEMS = [
    { href: "index.html", label: "Dashboard", icon: "grid", area: "inventory", need: "view" },
    { href: "inventory.html", label: "Inventory", icon: "list", area: "inventory", need: "view" },
    { href: "scan.html", label: "Scan", icon: "scan", area: "inventory", need: "edit" },
    { href: "employees.html", label: "Employees", icon: "people", area: "employees", need: "view" },
    { href: "call-list.html", label: "Call List", icon: "clipboard", area: "callList", need: "view" },
    { href: "settings.html", label: "Settings", icon: "settings", area: "settings", need: "view" }
  ];

  var ICONS = {
    grid: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
    list: '<path d="M3 7h18M3 12h18M3 17h18"/>',
    scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16"/>',
    people: '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.5a3.5 3.5 0 0 1 0 7M21 20c0-2.6-1.6-4.8-4-5.6"/>',
    clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M9 11h6M9 15h6"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
  };

  function brand() {
    return global.Branding ? Branding.get() : { appName: "Inventorium", appSubtitle: "", logo: null };
  }

  function accountFoot() {
    var me = global.Store && Store.getMe && Store.getMe();
    if (!me) return "<strong data-brand-name>" + esc(brand().appName) + "</strong><span class=\"dim\">Tech &amp; stage crew</span>";
    return '<div class="rail-user"><strong>' + esc(me.name) + "</strong>" +
      '<span class="dim">' + (Store.can("inventory", "edit") || Store.can("settings", "edit") || Store.can("employees", "edit") || Store.can("callList", "edit") ? "Signed in" : "Signed in (view only)") + "</span>" +
      '<button type="button" id="rail-signout" class="signout">Sign out</button></div>';
  }

  function buildRail(activeHref, foot) {
    var rail = document.getElementById("rail");
    if (!rail) return;

    var canOpen = function (n) {
      return !global.Store || !Store.getMe || !Store.getMe() || Store.can(n.area, n.need);
    };
    var links = NAV_ITEMS.filter(canOpen).map(function (n) {
      var current = n.href === activeHref ? ' aria-current="page"' : "";
      return (
        '<a href="' + n.href + '"' + current + ">" +
        '<svg viewBox="0 0 24 24">' + ICONS[n.icon] + "</svg>" +
        n.label +
        "</a>"
      );
    }).join("");

    var b = brand();
    rail.innerHTML =
      '<div class="brand">' +
      '<img class="brand-mark" data-brand-logo src="' + esc(global.Branding ? Branding.logoSrc() : "img/logo-placeholder.png") + '" alt="" aria-hidden="true" />' +
      '<div style="min-width:0"><span class="brand-name" data-brand-name style="overflow-wrap:anywhere">' + esc(b.appName) + "</span>" +
      '<span class="brand-sub" data-brand-sub>' + esc(b.appSubtitle) + "</span></div>" +
      "</div>" +
      '<nav class="nav" aria-label="Main">' + links + "</nav>" +
      '<div class="rail-foot">' + (foot || accountFoot()) + "</div>";
    var so = document.getElementById("rail-signout");
    if (so) so.addEventListener("click", function () { if (global.Auth) Auth.signOut(); });
  }

  /* ---------- Toasts ---------- */

  function toast(message, kind) {
    var host = document.getElementById("toast-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "toast-host";
      host.setAttribute("aria-live", "polite");
      host.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:200;display:flex;flex-direction:column;gap:8px;align-items:center;";
      document.body.appendChild(host);
    }
    var el = document.createElement("div");
    var color = kind === "error" ? "var(--fault)" : kind === "warn" ? "var(--warn)" : "var(--ok)";
    el.textContent = message;
    el.style.cssText =
      "background:var(--panel-raised);border:1px solid " + color + ";color:var(--text);" +
      "padding:12px 18px;border-radius:6px;font-size:.9rem;box-shadow:0 8px 24px rgba(0,0,0,.4);" +
      "opacity:0;transform:translateY(8px);transition:opacity .18s ease,transform .18s ease;max-width:88vw;";
    host.appendChild(el);
    requestAnimationFrame(function () {
      el.style.opacity = "1";
      el.style.transform = "translateY(0)";
    });
    setTimeout(function () {
      el.style.opacity = "0";
      el.style.transform = "translateY(8px)";
      setTimeout(function () {
        el.remove();
      }, 200);
    }, 2600);
  }

  /* ---------- Formatting ---------- */

  function timeAgo(ts) {
    var diff = Math.max(0, Date.now() - ts);
    var min = Math.floor(diff / 60000);
    if (min < 1) return "just now";
    if (min < 60) return min + "m ago";
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + "h ago";
    var day = Math.floor(hr / 24);
    return day + "d ago";
  }

  function clockTime(ts) {
    var d = new Date(ts);
    var h = d.getHours();
    var m = String(d.getMinutes()).padStart(2, "0");
    var ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return h + ":" + m + " " + ap;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* Plain-language description of one activity-log entry (see Store.addLog) */
  function describeLogEntry(e) {
    var name = esc(e.itemName || "Item");
    switch (e.type) {
      case "out": return name + " checked out";
      case "in": return name + " checked in";
      case "add": return name + " added to inventory";
      case "delete": return name + " removed from inventory";
      case "delete-employee": return esc(e.empName || "Employee") + " removed from employees";
      case "status": return e.note ? esc(e.note) : name + " — status updated";
      case "note": return e.note ? esc(e.note) : name + " — note added";
      case "restock": return name + " restocked" + (e.note ? " (" + esc(e.note) + ")" : "");
      case "use": return name + " used" + (e.note ? " (" + esc(e.note) + ")" : "");
      case "fault": return name + " flagged as damaged";
      default: return name + " updated";
    }
  }

  global.UI = {
    buildRail: buildRail,
    toast: toast,
    timeAgo: timeAgo,
    clockTime: clockTime,
    esc: esc,
    describeLogEntry: describeLogEntry
  };
})(window);
