(function () {
  "use strict";

  Store.init();
  UI.buildRail("settings.html");

  /* ================= Roles ================= */

  var roleRowsEl = document.getElementById("role-rows");
  var roleCountEl = document.getElementById("role-count");

  function renderRoles() {
    var roles = Store.getRoles();
    var emps = Store.getEmployees();
    var items = Store.getItems();

    if (!roles.length) {
      roleRowsEl.innerHTML = '<tr><td colspan="4" class="dim" style="padding:28px 16px">No role categories yet. Add one to start assigning roles to employees.</td></tr>';
    } else {
      roleRowsEl.innerHTML = roles
        .map(function (r) {
          var peopleCount = emps.filter(function (e) {
            return e.roleId === r.id;
          }).length;
          var itemCount = items.filter(function (it) {
            return Array.isArray(it.restrictedTo) && it.restrictedTo.indexOf(r.id) > -1;
          }).length;
          return (
            "<tr>" +
            '<td><span class="item-name">' + UI.esc(r.name) + "</span></td>" +
            "<td>" + peopleCount + (peopleCount === 1 ? " person" : " people") + "</td>" +
            "<td>" + (itemCount ? itemCount + (itemCount === 1 ? " item" : " items") : '<span class="dim">None</span>') + "</td>" +
            '<td><div class="row-actions">' +
            '<button class="icon-btn" data-edit-role="' + UI.esc(r.id) + '" title="Edit" aria-label="Edit ' + UI.esc(r.name) + '">' +
            '<svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>' +
            '<button class="icon-btn icon-btn-danger" data-delete-role="' + UI.esc(r.id) + '" title="Delete" aria-label="Delete ' + UI.esc(r.name) + '">' +
            '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button>' +
            "</div></td>" +
            "</tr>"
          );
        })
        .join("");
    }
    roleCountEl.textContent = roles.length + (roles.length === 1 ? " role" : " roles");
  }

  roleRowsEl.addEventListener("click", function (e) {
    var editBtn = e.target.closest("[data-edit-role]");
    if (editBtn) {
      openRoleDialog(Store.getRole(editBtn.getAttribute("data-edit-role")));
      return;
    }
    var delBtn = e.target.closest("[data-delete-role]");
    if (delBtn) {
      confirmDeleteRole(delBtn.getAttribute("data-delete-role"));
    }
  });

  function confirmDeleteRole(id) {
    var role = Store.getRole(id);
    if (!role) return;
    var inUse = Store.getEmployees().some(function (e) {
      return e.roleId === id;
    });
    if (inUse) {
      UI.toast("\"" + role.name + "\" is still assigned to employees — reassign them first", "error");
      return;
    }
    var ok = confirm("Delete \"" + role.name + "\"? Any item restrictions using it will be removed.");
    if (!ok) return;
    var res = Store.deleteRole(id);
    if (res.ok) {
      renderRoles();
      UI.toast("Deleted " + role.name);
    } else if (res.reason === "in-use") {
      UI.toast("\"" + role.name + "\" is still assigned to employees — reassign them first", "error");
    } else {
      UI.toast("Couldn't delete that role", "error");
    }
  }

  var roleDialog = document.getElementById("role-dialog");
  var roleForm = document.getElementById("role-form");
  var fRoleName = document.getElementById("f-role-name");
  var roleDialogTitle = document.getElementById("role-dialog-title");
  var editingRoleId = null;

  function openRoleDialog(existing) {
    editingRoleId = existing ? existing.id : null;
    roleDialogTitle.textContent = existing ? "Edit role" : "Add role";
    fRoleName.value = existing ? existing.name : "";
    document.getElementById("role-save-btn").textContent = existing ? "Save changes" : "Save role";
    document.getElementById("role-delete-btn").hidden = !existing;
    roleDialog.showModal();
    fRoleName.focus();
  }

  document.getElementById("add-role-btn").addEventListener("click", function () {
    openRoleDialog(null);
  });

  document.getElementById("role-cancel-btn").addEventListener("click", function () {
    roleDialog.close();
  });

  document.getElementById("role-delete-btn").addEventListener("click", function () {
    if (!editingRoleId) return;
    roleDialog.close();
    confirmDeleteRole(editingRoleId);
  });

  roleForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var name = fRoleName.value.trim();
    if (!name) return;

    var role = editingRoleId ? Store.getRole(editingRoleId) : { id: null };
    role.name = name;
    Store.saveRole(role);
    roleDialog.close();
    renderRoles();
    UI.toast(editingRoleId ? "Role updated" : "Role added");
  });

  /* ================= Locations ================= */

  var locationRowsEl = document.getElementById("location-rows");
  var locationCountEl = document.getElementById("location-count");

  function renderLocations() {
    var locations = Store.getLocations();
    var items = Store.getItems();

    if (!locations.length) {
      locationRowsEl.innerHTML = '<tr><td colspan="3" class="dim" style="padding:28px 16px">No locations yet. Add one to start assigning locations to items.</td></tr>';
    } else {
      locationRowsEl.innerHTML = locations
        .map(function (loc) {
          var itemCount = items.filter(function (it) {
            return it.location === loc;
          }).length;
          return (
            "<tr>" +
            '<td><span class="item-name">' + UI.esc(loc) + "</span></td>" +
            "<td>" + (itemCount ? itemCount + (itemCount === 1 ? " item" : " items") : '<span class="dim">None</span>') + "</td>" +
            '<td><div class="row-actions">' +
            '<button class="icon-btn" data-edit-location="' + UI.esc(loc) + '" title="Rename" aria-label="Rename ' + UI.esc(loc) + '">' +
            '<svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>' +
            '<button class="icon-btn icon-btn-danger" data-delete-location="' + UI.esc(loc) + '" title="Delete" aria-label="Delete ' + UI.esc(loc) + '">' +
            '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button>' +
            "</div></td>" +
            "</tr>"
          );
        })
        .join("");
    }
    locationCountEl.textContent = locations.length + (locations.length === 1 ? " location" : " locations");
  }

  locationRowsEl.addEventListener("click", function (e) {
    var editBtn = e.target.closest("[data-edit-location]");
    if (editBtn) {
      openLocationDialog(editBtn.getAttribute("data-edit-location"));
      return;
    }
    var delBtn = e.target.closest("[data-delete-location]");
    if (delBtn) {
      confirmDeleteLocation(delBtn.getAttribute("data-delete-location"));
    }
  });

  function confirmDeleteLocation(name) {
    var inUse = Store.getItems().some(function (it) {
      return it.location === name;
    });
    if (inUse) {
      UI.toast("\"" + name + "\" still has items stored there — move them first", "error");
      return;
    }
    var ok = confirm("Delete the \"" + name + "\" location?");
    if (!ok) return;
    var res = Store.deleteLocation(name);
    if (res.ok) {
      renderLocations();
      UI.toast("Deleted " + name);
    } else if (res.reason === "in-use") {
      UI.toast("\"" + name + "\" still has items stored there — move them first", "error");
    } else {
      UI.toast("Couldn't delete that location", "error");
    }
  }

  var locationDialog = document.getElementById("location-dialog");
  var locationForm = document.getElementById("location-form");
  var fLocationName = document.getElementById("f-location-name");
  var locationDialogTitle = document.getElementById("location-dialog-title");
  var editingLocationName = null;

  function openLocationDialog(existingName) {
    editingLocationName = existingName || null;
    locationDialogTitle.textContent = existingName ? "Rename location" : "Add location";
    fLocationName.value = existingName || "";
    document.getElementById("location-save-btn").textContent = existingName ? "Save changes" : "Save location";
    document.getElementById("location-delete-btn").hidden = !existingName;
    locationDialog.showModal();
    fLocationName.focus();
  }

  document.getElementById("add-location-btn").addEventListener("click", function () {
    openLocationDialog(null);
  });

  document.getElementById("location-cancel-btn").addEventListener("click", function () {
    locationDialog.close();
  });

  document.getElementById("location-delete-btn").addEventListener("click", function () {
    if (!editingLocationName) return;
    locationDialog.close();
    confirmDeleteLocation(editingLocationName);
  });

  locationForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var name = fLocationName.value.trim();
    if (!name) return;

    var res = Store.saveLocation(editingLocationName, name);
    if (res.ok) {
      locationDialog.close();
      renderLocations();
      UI.toast(editingLocationName ? "Location updated" : "Location added");
    } else if (res.reason === "duplicate") {
      UI.toast("That location already exists", "error");
    } else {
      UI.toast("Couldn't save that location", "error");
    }
  });

  renderRoles();
  renderLocations();
  /* ================= Show roles & Shows ================= */

  var ICON_EDIT = '<svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  var ICON_DEL = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';

  function people(n) {
    return n ? n + (n === 1 ? " person" : " people") : '<span class="dim">None</span>';
  }

  // Shared name-list section: table + add/edit/delete dialog.
  function nameSection(c) {
    var rowsEl = document.getElementById(c.pre + "-rows");
    var countEl = document.getElementById(c.pre + "-count");
    var dialog = document.getElementById(c.pre + "-dialog");
    var form = document.getElementById(c.pre + "-form");
    var input = document.getElementById("f-" + c.pre + "-name");
    var title = document.getElementById(c.pre + "-dialog-title");
    var saveBtn = document.getElementById(c.pre + "-save-btn");
    var delBtn = document.getElementById(c.pre + "-delete-btn");
    var editingId = null;

    function render() {
      var list = c.list();
      if (!list.length) {
        rowsEl.innerHTML = '<tr><td colspan="3" class="dim" style="padding:28px 16px">' + c.empty + "</td></tr>";
      } else {
        rowsEl.innerHTML = list.map(function (r) {
          return "<tr><td><span class=\"item-name\">" + UI.esc(r.name) + "</span></td><td>" + people(c.used(r.id)) + "</td>" +
            '<td><div class="row-actions">' +
            '<button class="icon-btn" data-edit="' + UI.esc(r.id) + '" title="Edit" aria-label="Edit ' + UI.esc(r.name) + '">' + ICON_EDIT + "</button>" +
            '<button class="icon-btn icon-btn-danger" data-del="' + UI.esc(r.id) + '" title="Delete" aria-label="Delete ' + UI.esc(r.name) + '">' + ICON_DEL + "</button>" +
            "</div></td></tr>";
        }).join("");
      }
      countEl.textContent = list.length + " " + (list.length === 1 ? c.one : c.many);
    }

    function open(existing) {
      editingId = existing ? existing.id : null;
      title.textContent = (existing ? "Edit " : "Add ") + c.noun;
      input.value = existing ? existing.name : "";
      saveBtn.textContent = existing ? "Save changes" : "Save " + c.noun;
      delBtn.hidden = !existing;
      dialog.showModal();
      input.focus();
    }

    function confirmDelete(id) {
      var r = c.get(id);
      if (!r) return;
      if (c.blocked && c.blocked(id)) {
        UI.toast(c.blocked(id), "error");
        return;
      }
      if (!confirm(c.confirmText(r))) return;
      var res = c.del(id);
      if (res.ok) {
        render();
        if (c.after) c.after();
        UI.toast("Deleted " + r.name);
      } else {
        UI.toast("Couldn't delete that " + c.noun, "error");
      }
    }

    rowsEl.addEventListener("click", function (e) {
      var ed = e.target.closest("[data-edit]");
      if (ed) return open(c.get(ed.getAttribute("data-edit")));
      var dl = e.target.closest("[data-del]");
      if (dl) confirmDelete(dl.getAttribute("data-del"));
    });
    document.getElementById("add-" + c.pre + "-btn").addEventListener("click", function () { open(null); });
    document.getElementById(c.pre + "-cancel-btn").addEventListener("click", function () { dialog.close(); });
    delBtn.addEventListener("click", function () {
      if (!editingId) return;
      dialog.close();
      confirmDelete(editingId);
    });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var name = input.value.trim();
      if (!name) return;
      var rec = editingId ? c.get(editingId) : { id: null };
      rec.name = name;
      c.save(rec);
      dialog.close();
      render();
      if (c.after) c.after();
      UI.toast(editingId ? "Updated" : "Added");
    });
    render();
    return render;
  }

  var renderShowsRef;
  nameSection({
    pre: "showrole", noun: "show role", one: "role", many: "roles",
    empty: "No show roles yet. Add positions like Stage Manager or A2 to use on the Call List page.",
    list: Store.getShowRoles, get: Store.getShowRole.bind(Store), save: Store.saveShowRole.bind(Store), del: Store.deleteShowRole.bind(Store),
    used: function (id) { return Store.getCallList().filter(function (x) { return x.showRoleId === id; }).length; },
    blocked: function (id) {
      var r = Store.getShowRole(id);
      var inUse = Store.getCallList().some(function (x) { return x.showRoleId === id; });
      return inUse ? "\"" + r.name + "\" is still used on a call list — reassign those first" : "";
    },
    confirmText: function (r) { return "Delete the \"" + r.name + "\" show role?"; }
  });
  renderShowsRef = nameSection({
    pre: "show", noun: "show", one: "show", many: "shows",
    empty: "No shows yet. Add one to start building its call list.",
    list: Store.getShows, get: Store.getShow.bind(Store), save: Store.saveShow.bind(Store), del: Store.deleteShow.bind(Store),
    used: function (id) { return Store.getCallListForShow(id).length; },
    confirmText: function (r) {
      var n = Store.getCallListForShow(r.id).length;
      return "Delete \"" + r.name + "\"?" + (n ? " Its call list of " + n + (n === 1 ? " person" : " people") + " will be deleted too." : "") + " This can't be undone.";
    }
  });

  /* ================= Branding ================= */

  (function () {
    var form = document.getElementById("branding-form");
    var fName = document.getElementById("f-brand-name");
    var fSub = document.getElementById("f-brand-sub");
    var fFile = document.getElementById("f-brand-logo");
    var pick = document.getElementById("brand-logo-pick");
    var removeBtn = document.getElementById("brand-logo-remove");
    var logoPreview = document.getElementById("brand-logo-preview");
    var pName = document.getElementById("brand-preview-name");
    var pSub = document.getElementById("brand-preview-sub");
    var pLogo = document.getElementById("brand-preview-logo");
    var saveBtn = document.getElementById("brand-save");
    var logo = null;
    var canEdit = Store.can("settings", "edit");

    function draw() {
      var name = fName.value.trim() || Branding.DEFAULTS.appName;
      var src = Branding.logoSrc({ logo: logo });
      pName.textContent = name;
      pSub.textContent = fSub.value.trim();
      pLogo.src = src;
      logoPreview.src = src;
      removeBtn.hidden = !logo;
    }
    function fill(d) {
      fName.value = d.appName;
      fSub.value = d.appSubtitle;
      logo = d.logo;
      draw();
    }
    fill(Branding.get());
    if (!canEdit) { fName.disabled = true; fSub.disabled = true; }

    fName.addEventListener("input", draw);
    fSub.addEventListener("input", draw);
    pick.addEventListener("click", function () { fFile.click(); });
    removeBtn.addEventListener("click", function () { logo = null; fFile.value = ""; draw(); });

    // Shrink to a small PNG (keeps transparency) so it stays light to store and load.
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
    fFile.addEventListener("change", function () {
      var file = fFile.files && fFile.files[0];
      if (!file) return;
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { UI.toast("Choose a PNG, JPEG or WebP image", "error"); return; }
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          var url = shrink(img);
          if (!url) { UI.toast("That image is too large — try a smaller one", "error"); return; }
          logo = url;
          draw();
        };
        img.onerror = function () { UI.toast("Couldn't read that image", "error"); };
        img.src = reader.result;
      };
      reader.onerror = function () { UI.toast("Couldn't read that image", "error"); };
      reader.readAsDataURL(file);
    });

    function busy(on) { saveBtn.disabled = on; saveBtn.textContent = on ? "Saving…" : "Save branding"; }
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!canEdit) return;
      busy(true);
      Branding.save({ appName: fName.value, appSubtitle: fSub.value, logo: logo }).then(function (d) {
        fill(d);
        UI.toast("Branding saved");
      }).catch(function (err) {
        UI.toast(err.message || "Couldn't save branding", "error");
      }).then(function () { busy(false); });
    });
    document.getElementById("brand-reset").addEventListener("click", function () {
      if (!canEdit || !confirm("Reset the name and logo to the generic placeholders?")) return;
      Branding.reset().then(function (d) {
        fill(d);
        UI.toast("Reset to placeholders");
      }).catch(function (err) { UI.toast(err.message || "Couldn't reset", "error"); });
    });
  })();

  /* ================= Import old browser data ================= */

  (function () {
    var section = document.getElementById("import-section");
    var legacy = Store.legacyLocalData();
    var isAdmin = ["inventory", "employees", "callList", "settings"].every(function (a) { return Store.can(a, "edit"); });
    if (!legacy || !isAdmin) return;

    section.hidden = false;
    document.getElementById("import-summary").textContent =
      "Found " + legacy.items.length + " items, " + legacy.employees.length + " employees, " +
      legacy.shows.length + " shows and " + legacy.callEntries.length + " call-list entries saved in this browser.";

    var btn = document.getElementById("import-btn");
    btn.addEventListener("click", function () {
      if (!confirm("Import the data saved in this browser into the cloud?")) return;
      btn.disabled = true;
      btn.textContent = "Importing…";
      Store.importLegacy(legacy).then(function () {
        UI.toast("Imported — reloading");
        setTimeout(function () { location.reload(); }, 900);
      }).catch(function (err) {
        UI.toast(err.message || "Import failed", "error");
        btn.disabled = false;
        btn.textContent = "Import into the cloud";
      });
    });
  })();
})();
