(function () {
  "use strict";

  Store.init();
  UI.buildRail("employees.html");

  var rowsEl = document.getElementById("rows");
  var countEl = document.getElementById("row-count");
  var query = "";

  function roleName(roleId) {
    var role = roleId ? Store.getRole(roleId) : null;
    return role ? role.name : "";
  }

  function render() {
    var emps = Store.getEmployees();
    var q = query.trim().toLowerCase();
    var list = emps.filter(function (e) {
      var haystack = (e.name + " " + e.id + " " + roleName(e.roleId)).toLowerCase();
      return !q || haystack.indexOf(q) > -1;
    });

    if (!list.length) {
      var emptyMsg = emps.length === 0
        ? "No employees yet. Add crew and staff so they can check gear in and out."
        : "No employees match your search.";
      rowsEl.innerHTML = '<tr><td colspan="5" class="dim" style="padding:28px 16px">' + emptyMsg + "</td></tr>";
    } else {
      rowsEl.innerHTML = list
        .map(function (e) {
          var heldCount = Store.getItems().filter(function (it) {
            return it.holder === e.id;
          }).length;
          return (
            "<tr>" +
            '<td>' + (e.photo ? '<img class="row-thumb row-thumb-round" src="' + e.photo + '" alt="" />' : "") + '<span class="item-name">' + UI.esc(e.name) + "</span>" +
            (heldCount ? '<span class="item-loc">Holding ' + heldCount + (heldCount === 1 ? " item" : " items") + "</span>" : "") +
            "</td>" +
            '<td class="mono">' + UI.esc(e.id) + "</td>" +
            "<td>" + UI.esc(roleName(e.roleId) || "—") + "</td>" +
            "<td>" + (e.active
              ? '<span class="badge badge-ok">Active</span>'
              : '<span class="badge badge-fault">Inactive</span>') + "</td>" +
            '<td><div class="row-actions">' +
            '<button class="icon-btn" data-card="' + UI.esc(e.id) + '" title="Generate ID card" aria-label="Generate ID card for ' + UI.esc(e.name) + '">' +
            '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15h4M7 11h.01"/></svg></button>' +
            '<button class="icon-btn" data-edit="' + UI.esc(e.id) + '" title="Edit" aria-label="Edit ' + UI.esc(e.name) + '">' +
            '<svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>' +
            '<button class="icon-btn icon-btn-danger" data-delete="' + UI.esc(e.id) + '" title="Delete" aria-label="Delete ' + UI.esc(e.name) + '">' +
            '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button>' +
            "</div></td>" +
            "</tr>"
          );
        })
        .join("");
    }
    countEl.textContent = list.length + (list.length === 1 ? " employee" : " employees");
  }

  document.getElementById("search").addEventListener("input", function (e) {
    query = e.target.value;
    render();
  });

  rowsEl.addEventListener("click", function (e) {
    var cardBtn = e.target.closest("[data-card]");
    if (cardBtn) {
      openCard(cardBtn.getAttribute("data-card"));
      return;
    }
    var editBtn = e.target.closest("[data-edit]");
    if (editBtn) {
      openEmpDialog(Store.getEmployee(editBtn.getAttribute("data-edit")));
      return;
    }
    var delBtn = e.target.closest("[data-delete]");
    if (delBtn) {
      confirmDelete(delBtn.getAttribute("data-delete"));
    }
  });

  function confirmDelete(id) {
    var emp = Store.getEmployee(id);
    if (!emp) return;
    var holding = Store.getItems().some(function (it) {
      return it.holder === id;
    });
    if (holding) {
      UI.toast(emp.name + " is still holding items — check those in first", "error");
      return;
    }
    var ok = confirm("Delete \"" + emp.name + "\" (" + emp.id + ")? This can't be undone.");
    if (!ok) return;
    var res = Store.deleteEmployee(id);
    if (res.ok) {
      render();
      UI.toast("Deleted " + emp.name);
    } else {
      UI.toast("Couldn't delete that employee", "error");
    }
  }

  /* ---------- Add / edit dialog ---------- */

  var dialog = document.getElementById("emp-dialog");
  var form = document.getElementById("emp-form");
  var fName = document.getElementById("f-name");
  var fId = document.getElementById("f-id");
  var fRole = document.getElementById("f-role");
  var fActive = document.getElementById("f-active");
  var dialogTitle = document.getElementById("dialog-title");
  var editingId = null;

  var fPhotoInput = document.getElementById("f-photo-input");
  var fPhotoPick = document.getElementById("f-photo-pick");
  var fPhotoRemove = document.getElementById("f-photo-remove");
  var fPhotoPreview = document.getElementById("f-photo-preview");
  var pendingPhoto = null;

  function renderPhotoPreview() {
    if (pendingPhoto) {
      fPhotoPreview.innerHTML = '<img src="' + pendingPhoto + '" alt="" />';
      fPhotoRemove.hidden = false;
    } else {
      fPhotoPreview.innerHTML = '<span class="dim" style="font-size:.78rem">No photo</span>';
      fPhotoRemove.hidden = true;
    }
  }
  fPhotoPick.addEventListener("click", function () { fPhotoInput.click(); });
  fPhotoRemove.addEventListener("click", function () {
    pendingPhoto = null;
    fPhotoInput.value = "";
    renderPhotoPreview();
  });
  fPhotoInput.addEventListener("change", function () {
    var file = fPhotoInput.files && fPhotoInput.files[0];
    if (!file) return;
    if (!file.type || file.type.indexOf("image/") !== 0) {
      UI.toast("Choose an image file", "error");
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        // Center square crop so faces fill the call-list tiles.
        var side = Math.min(img.width, img.height);
        var out = Math.min(480, side);
        var canvas = document.createElement("canvas");
        canvas.width = out;
        canvas.height = out;
        canvas.getContext("2d").drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, out, out);
        pendingPhoto = canvas.toDataURL("image/jpeg", 0.75);
        renderPhotoPreview();
      };
      img.onerror = function () { UI.toast("Couldn't read that image", "error"); };
      img.src = reader.result;
    };
    reader.onerror = function () { UI.toast("Couldn't read that image", "error"); };
    reader.readAsDataURL(file);
  });

  var fEmail = document.getElementById("f-email");
  var fPassword = document.getElementById("f-password");
  var fPermInv = document.getElementById("f-perm-inventory");
  var fPermCall = document.getElementById("f-perm-call");
  var fPermEmp = document.getElementById("f-perm-employees");
  var fPermSet = document.getElementById("f-perm-settings");

  function populateRoleSelect(selectedId) {
    var roles = Store.getRoles();
    fRole.innerHTML = "";
    roles.forEach(function (r) {
      var opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = r.name;
      fRole.appendChild(opt);
    });
    var hasRoles = roles.length > 0;
    fRole.hidden = !hasRoles;
    document.getElementById("f-role-empty").hidden = hasRoles;
    fRole.disabled = !hasRoles;
    if (hasRoles) {
      var match = roles.some(function (r) {
        return r.id === selectedId;
      });
      fRole.value = match ? selectedId : roles[0].id;
    }
  }

  function openEmpDialog(existing) {
    editingId = existing ? existing.id : null;
    dialogTitle.textContent = existing ? "Edit employee" : "Add employee";
    fName.value = existing ? existing.name : "";
    populateRoleSelect(existing ? existing.roleId : null);
    fActive.checked = existing ? !!existing.active : true;
    fEmail.value = existing ? existing.email || "" : "";
    fPassword.value = "";
    fPassword.placeholder = existing && existing.email ? "Leave blank to keep the current password" : "Set a password so they can sign in";
    fPermInv.value = existing ? existing.permInventory || "none" : "none";
    fPermCall.value = existing ? existing.permCallList || "none" : "none";
    fPermEmp.value = existing ? existing.permEmployees || "none" : "none";
    fPermSet.value = existing ? existing.permSettings || "none" : "none";
    pendingPhoto = existing ? existing.photo || null : null;
    fPhotoInput.value = "";
    renderPhotoPreview();
    fId.value = existing ? existing.id : Store.nextEmployeeId();
    fId.readOnly = !!existing;
    document.getElementById("f-id-regen").hidden = !!existing;
    document.getElementById("save-btn").textContent = existing ? "Save changes" : "Save employee";
    document.getElementById("delete-btn").hidden = !existing;
    dialog.showModal();
    fName.focus();
  }

  document.getElementById("add-emp-btn").addEventListener("click", function () {
    openEmpDialog(null);
  });

  document.getElementById("cancel-btn").addEventListener("click", function () {
    dialog.close();
  });

  document.getElementById("delete-btn").addEventListener("click", function () {
    if (!editingId) return;
    dialog.close();
    confirmDelete(editingId);
  });

  document.getElementById("f-id-regen").addEventListener("click", function () {
    fId.value = Store.nextEmployeeId();
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var id = fId.value.trim().toUpperCase();
    if (!id || !fName.value.trim()) return;

    var clash = Store.getEmployee(id);
    if (clash && !editingId) {
      UI.toast("That ID is already in use", "error");
      return;
    }

    var email = fEmail.value.trim().toLowerCase();
    var password = fPassword.value;
    if (password && !email) { UI.toast("Add an email so they can sign in with that password", "error"); return; }
    if (password && password.length < 8) { UI.toast("Password must be at least 8 characters", "error"); return; }

    var prev = editingId ? Store.getEmployee(editingId) : null;
    var emp = prev ? Object.assign({}, prev) : { id: id };
    emp.id = id;
    emp.name = fName.value.trim();
    emp.roleId = fRole.disabled ? null : fRole.value;
    emp.active = fActive.checked;
    emp.photo = pendingPhoto;
    emp.email = email;
    emp.permInventory = fPermInv.value;
    emp.permCallList = fPermCall.value;
    emp.permEmployees = fPermEmp.value;
    emp.permSettings = fPermSet.value;

    var saveBtn = document.getElementById("save-btn");
    saveBtn.disabled = true;
    Store.saveEmployeeAsync(emp, password).then(function (res) {
      dialog.close();
      render();
      var msg = editingId ? "Employee updated" : "Employee added — generate their ID card when ready";
      if (res && res.loginCreated) msg += " · login created";
      else if (res && res.loginUpdated) msg += " · password updated";
      UI.toast(msg);
      if (!editingId) openCard(emp.id);
    }).catch(function (err) {
      UI.toast(err.message || "Couldn't save", "error");
    }).then(function () {
      saveBtn.disabled = false;
    });
  });

  /* ---------- ID card dialog ---------- */

  var bcDialog = document.getElementById("barcode-dialog");
  var bcName = document.getElementById("bc-name");
  var bcRole = document.getElementById("bc-role");
  var bcId = document.getElementById("bc-id");
  var bcSvg = document.getElementById("bc-svg");

  function openCard(empId) {
    var emp = Store.getEmployee(empId);
    if (!emp) return;
    bcName.textContent = emp.name;
    bcRole.textContent = roleName(emp.roleId);
    bcId.textContent = emp.id;
    try {
      JsBarcode(bcSvg, emp.id, {
        format: "CODE128",
        lineColor: "#111",
        background: "#ffffff",
        width: 2,
        height: 64,
        displayValue: false,
        margin: 6
      });
    } catch (err) {
      console.error("Barcode render failed", err);
    }
    bcDialog.showModal();
  }

  document.getElementById("bc-close").addEventListener("click", function () {
    bcDialog.close();
  });
  document.getElementById("bc-print").addEventListener("click", function () {
    window.print();
  });

  render();
})();
