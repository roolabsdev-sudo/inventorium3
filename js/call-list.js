(function () {
  "use strict";

  Store.init();
  UI.buildRail("call-list.html");

  var showSelect = document.getElementById("show-select");
  var addBtn = document.getElementById("add-person-btn");
  var noShows = document.getElementById("no-shows-note");
  var gridEl = document.getElementById("roster-grid");
  var emptyEl = document.getElementById("roster-empty");

  // Access is controlled by the person's login permissions (boot.js), not an ID scan.
  var viewer = Store.getMe();
  document.getElementById("viewer-badge").textContent = viewer ? viewer.name : "";

  /* ---------- Show picker ---------- */

  function populateShows(keep) {
    var shows = Store.getShows();
    showSelect.innerHTML = "";
    shows.forEach(function (s) {
      var o = document.createElement("option");
      o.value = s.id;
      o.textContent = s.name;
      showSelect.appendChild(o);
    });
    if (keep && shows.some(function (s) { return s.id === keep; })) showSelect.value = keep;
    var has = shows.length > 0;
    showSelect.hidden = !has;
    addBtn.disabled = !has;
    noShows.style.display = has ? "none" : "block";
  }

  showSelect.addEventListener("change", render);

  /* ---------- Roster grid ---------- */

  function render() {
    var showId = showSelect.value;
    if (!showId) {
      gridEl.innerHTML = "";
      emptyEl.style.display = "none";
      return;
    }
    var entries = Store.getCallListForShow(showId).map(function (c) {
      var emp = Store.getEmployee(c.empId);
      var role = Store.getShowRole(c.showRoleId);
      return { c: c, emp: emp, role: role };
    }).filter(function (x) { return x.emp; });

    entries.sort(function (a, b) {
      return (a.role ? a.role.name : "~").localeCompare(b.role ? b.role.name : "~") || a.emp.name.localeCompare(b.emp.name);
    });

    emptyEl.style.display = entries.length ? "none" : "block";
    gridEl.innerHTML = entries.map(function (x) {
      var initial = UI.esc((x.emp.name || "?").trim().charAt(0).toUpperCase());
      var photo = x.emp.photo ? '<img src="' + x.emp.photo + '" alt="" />' : initial;
      return (
        '<div class="call-card">' +
        '<div class="call-photo">' + photo + "</div>" +
        '<div class="call-info">' +
        '<div><div class="call-name">' + UI.esc(x.emp.name) + "</div>" +
        '<div class="call-role">' + UI.esc(x.role ? x.role.name : "No role") + "</div></div>" +
        '<div class="call-actions">' +
        '<button type="button" class="comm-toggle" data-comm="' + UI.esc(x.c.id) + '" aria-pressed="' + (x.c.comm ? "true" : "false") + '">' +
        (x.c.comm ? "Comm" : "No comm") + "</button>" +
        '<button type="button" class="icon-btn icon-btn-danger" data-remove="' + UI.esc(x.c.id) + '" title="Remove" aria-label="Remove ' + UI.esc(x.emp.name) + '">' +
        '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button>' +
        "</div></div></div>"
      );
    }).join("");
  }

  gridEl.addEventListener("click", function (e) {
    var comm = e.target.closest("[data-comm]");
    if (comm) {
      var id = comm.getAttribute("data-comm");
      var entry = Store.getCallList().find(function (c) { return c.id === id; });
      if (entry) {
        entry.comm = !entry.comm;
        Store.saveCallEntry(entry);
        render();
      }
      return;
    }
    var rm = e.target.closest("[data-remove]");
    if (rm) {
      Store.deleteCallEntry(rm.getAttribute("data-remove"));
      render();
    }
  });

  /* ---------- Add person dialog ---------- */

  var dialog = document.getElementById("person-dialog");
  var fEmp = document.getElementById("f-person-emp");
  var fRole = document.getElementById("f-person-role");
  var fComm = document.getElementById("f-person-comm");
  var saveBtn = document.getElementById("person-save-btn");

  function fillSelect(sel, items, emptyId) {
    sel.innerHTML = "";
    items.forEach(function (it) {
      var o = document.createElement("option");
      o.value = it.id;
      o.textContent = it.label;
      sel.appendChild(o);
    });
    var has = items.length > 0;
    sel.hidden = !has;
    document.getElementById(emptyId).hidden = has;
    return has;
  }

  addBtn.addEventListener("click", function () {
    var showId = showSelect.value;
    if (!showId) return;
    var taken = Store.getCallListForShow(showId).map(function (c) { return c.empId; });
    var emps = Store.getEmployees().filter(function (e) {
      return e.active && taken.indexOf(e.id) === -1;
    }).map(function (e) { return { id: e.id, label: e.name + " (" + e.id + ")" }; });
    var roles = Store.getShowRoles().map(function (r) { return { id: r.id, label: r.name }; });
    var okEmp = fillSelect(fEmp, emps, "f-person-emp-empty");
    var okRole = fillSelect(fRole, roles, "f-person-role-empty");
    saveBtn.disabled = !(okEmp && okRole);
    fComm.checked = false;
    dialog.showModal();
  });

  document.getElementById("person-cancel-btn").addEventListener("click", function () {
    dialog.close();
  });

  document.getElementById("person-form").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!fEmp.value || !fRole.value) return;
    Store.saveCallEntry({
      id: null,
      showId: showSelect.value,
      empId: fEmp.value,
      showRoleId: fRole.value,
      comm: fComm.checked
    });
    dialog.close();
    render();
    UI.toast("Added to call list");
  });

  populateShows();
  render();
})();
