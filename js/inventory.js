(function () {
  "use strict";

  Store.init();
  UI.buildRail("inventory.html");

  var rowsEl = document.getElementById("rows");
  var countEl = document.getElementById("row-count");
  var activeFilter = "all";
  var query = "";
  var expandedGroups = {};

  /* ---------- Render list ---------- */

  function groupKey(it) {
    return it.groupId || it.id;
  }

  function renderUnitRow(it, indented) {
    var s = Store.STATUS[it.status];
    var holder = it.holder ? Store.getEmployee(it.holder) : null;
    var restricted = Array.isArray(it.restrictedTo) && it.restrictedTo.length;
    var thumb = !indented && it.photo ? '<img class="row-thumb" src="' + it.photo + '" alt="" />' : "";
    return (
      "<tr" + (indented ? ' class="row-sub"' : "") + ">" +
      "<td>" + thumb + '<span class="item-name">' + (indented ? UI.esc(it.id) : UI.esc(it.name)) +
      (restricted && !indented
        ? ' <span class="item-restricted" title="Restricted to certain roles"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></span>'
        : "") +
      '</span><span class="item-loc">' +
      (holder ? "With " + UI.esc(holder.name) : UI.esc(it.category)) + "</span></td>" +
      '<td class="mono">' + UI.esc(it.id) + "</td>" +
      "<td>" + UI.esc(it.location) + "</td>" +
      '<td><span class="badge ' + s.cls + '">' + s.label + "</span></td>" +
      '<td><div class="row-actions">' +
      '<button class="icon-btn" data-barcode="' + UI.esc(it.id) + '" title="Generate barcode" aria-label="Generate barcode for ' + UI.esc(it.name) + '">' +
      '<svg viewBox="0 0 24 24"><path d="M4 5v14M8 5v14M11 5v14M15 5v14M17 5v14M20 5v14"/></svg></button>' +
      '<button class="icon-btn" data-edit="' + UI.esc(it.id) + '" title="Edit" aria-label="Edit ' + UI.esc(it.name) + '">' +
      '<svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>' +
      '<button class="icon-btn icon-btn-danger" data-delete="' + UI.esc(it.id) + '" title="Delete" aria-label="Delete ' + UI.esc(it.name) + '">' +
      '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button>' +
      "</div></td>" +
      "</tr>"
    );
  }

  function renderConsumableRow(it) {
    var level = Store.stockLevel(it);
    var levelCls = level === "out" ? "badge-fault" : level === "low" ? "badge-maint" : "badge-ok";
    var levelLabel = level === "out" ? "Out of stock" : level === "low" ? "Low stock" : "In stock";
    var qtyLabel = (it.quantity || 0) + " " + UI.esc(it.unitLabel || "units");
    var thumb = it.photo ? '<img class="row-thumb" src="' + it.photo + '" alt="" />' : "";
    return (
      "<tr>" +
      "<td>" + thumb + '<span class="item-name">' + UI.esc(it.name) + '</span><span class="item-loc">' +
      UI.esc(it.category) + " · " + qtyLabel + "</span></td>" +
      '<td class="mono">' + UI.esc(it.id) + "</td>" +
      "<td>" + UI.esc(it.location) + "</td>" +
      '<td><span class="badge ' + levelCls + '">' + levelLabel + "</span></td>" +
      '<td><div class="row-actions">' +
      '<button class="icon-btn" data-restock="' + UI.esc(it.id) + '" title="Restock" aria-label="Restock ' + UI.esc(it.name) + '">' +
      '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>' +
      '<button class="icon-btn" data-use="' + UI.esc(it.id) + '" title="Log use" aria-label="Log use of ' + UI.esc(it.name) + '">' +
      '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg></button>' +
      '<button class="icon-btn" data-edit="' + UI.esc(it.id) + '" title="Edit" aria-label="Edit ' + UI.esc(it.name) + '">' +
      '<svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>' +
      '<button class="icon-btn icon-btn-danger" data-delete="' + UI.esc(it.id) + '" title="Delete" aria-label="Delete ' + UI.esc(it.name) + '">' +
      '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button>' +
      "</div></td>" +
      "</tr>"
    );
  }

  function renderGroupHeaderRow(key, filteredUnits) {
    var allUnits = Store.itemsInGroup(key);
    var template = allUnits[0];
    var avail = Store.groupAvailability(key);
    var restricted = Array.isArray(template.restrictedTo) && template.restrictedTo.length;
    var locations = allUnits.reduce(function (set, it) {
      set[it.location] = true;
      return set;
    }, {});
    var locLabel = Object.keys(locations).length === 1 ? UI.esc(template.location) : "Multiple locations";
    var expanded = !!expandedGroups[key];
    var statusCls = avail.available > 0 ? "badge-ok" : "badge-out";
    return (
      '<tr class="row-group" data-group-row="' + UI.esc(key) + '">' +
      '<td><button class="group-toggle" type="button" data-toggle-group="' + UI.esc(key) + '" aria-expanded="' + expanded + '">' +
      '<svg class="group-caret" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>' +
      '<span class="item-name">' + UI.esc(template.name) +
      (restricted
        ? ' <span class="item-restricted" title="Restricted to certain roles"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></span>'
        : "") +
      '</span></button><span class="item-loc">' + avail.available + " of " + avail.total + " available</span></td>" +
      '<td class="mono">' + UI.esc(key) + '<span class="item-loc">' + avail.total + " units</span></td>" +
      "<td>" + locLabel + "</td>" +
      '<td><span class="badge ' + statusCls + '">' + avail.available + " available</span></td>" +
      '<td><div class="row-actions">' +
      '<button class="icon-btn" data-add-unit="' + UI.esc(key) + '" title="Add another unit" aria-label="Add another unit of ' + UI.esc(template.name) + '">' +
      '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>' +
      "</div></td>" +
      "</tr>"
    );
  }

  function render() {
    var items = Store.getItems();
    var q = query.trim().toLowerCase();
    var list = items.filter(function (it) {
      var matchesStatus = activeFilter === "all"
        ? true
        : activeFilter === "low-stock"
          ? (it.trackingMode === "consumable" && Store.stockLevel(it) !== "ok")
          : it.status === activeFilter;
      var haystack = (it.name + " " + it.id + " " + (it.aliases || "") + " " + it.location + " " + (it.serial || "")).toLowerCase();
      var matchesQuery = !q || haystack.indexOf(q) > -1;
      return matchesStatus && matchesQuery;
    });

    if (!list.length) {
      var emptyMsg = items.length === 0
        ? "No items yet. Add your first item, or scan an untagged one from the Scan page."
        : "No items match your search or filter.";
      rowsEl.innerHTML = '<tr><td colspan="5" class="dim" style="padding:28px 16px">' + emptyMsg + "</td></tr>";
      countEl.textContent = "0 items";
      return;
    }

    // Group filtered items by their groupId (falls back to the item's own id,
    // so single-quantity items render exactly as before).
    var order = [];
    var byGroup = {};
    list.forEach(function (it) {
      var key = groupKey(it);
      if (!byGroup[key]) {
        byGroup[key] = [];
        order.push(key);
      }
      byGroup[key].push(it);
    });

    var html = "";
    order.forEach(function (key) {
      if (byGroup[key][0].trackingMode === "consumable") {
        html += renderConsumableRow(byGroup[key][0]);
        return;
      }
      var allUnits = Store.itemsInGroup(key);
      if (allUnits.length <= 1) {
        html += renderUnitRow(byGroup[key][0], false);
      } else {
        html += renderGroupHeaderRow(key, byGroup[key]);
        if (expandedGroups[key]) {
          byGroup[key]
            .slice()
            .sort(function (a, b) {
              return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
            })
            .forEach(function (it) {
              html += renderUnitRow(it, true);
            });
        }
      }
    });
    rowsEl.innerHTML = html;
    countEl.textContent = list.length + (list.length === 1 ? " item" : " items");
  }

  document.getElementById("search").addEventListener("input", function (e) {
    query = e.target.value;
    render();
  });

  document.querySelectorAll("[data-filter]").forEach(function (chip) {
    chip.addEventListener("click", function () {
      activeFilter = chip.getAttribute("data-filter");
      document.querySelectorAll("[data-filter]").forEach(function (c) {
        c.setAttribute("aria-pressed", String(c === chip));
      });
      render();
    });
  });

  rowsEl.addEventListener("click", function (e) {
    var toggleBtn = e.target.closest("[data-toggle-group]");
    if (toggleBtn) {
      var key = toggleBtn.getAttribute("data-toggle-group");
      expandedGroups[key] = !expandedGroups[key];
      render();
      return;
    }
    var addUnitBtn = e.target.closest("[data-add-unit]");
    if (addUnitBtn) {
      var groupId = addUnitBtn.getAttribute("data-add-unit");
      var res = Store.addUnit(groupId);
      if (res.ok) {
        expandedGroups[groupId] = true;
        render();
        UI.toast("Added another unit — generate its barcode when ready");
        openBarcode(res.item.id);
      } else {
        UI.toast("Couldn't add another unit", "error");
      }
      return;
    }
    var bcBtn = e.target.closest("[data-barcode]");
    if (bcBtn) {
      openBarcode(bcBtn.getAttribute("data-barcode"));
      return;
    }
    var restockBtn = e.target.closest("[data-restock]");
    if (restockBtn) {
      openStockDialog(restockBtn.getAttribute("data-restock"));
      return;
    }
    var useBtn = e.target.closest("[data-use]");
    if (useBtn) {
      openStockDialog(useBtn.getAttribute("data-use"));
      return;
    }
    var editBtn = e.target.closest("[data-edit]");
    if (editBtn) {
      openItemDialog(Store.getItem(editBtn.getAttribute("data-edit")));
      return;
    }
    var delBtn = e.target.closest("[data-delete]");
    if (delBtn) {
      confirmDelete(delBtn.getAttribute("data-delete"));
    }
  });

  function confirmDelete(id) {
    var item = Store.getItem(id);
    if (!item) return;
    if (item.status === "out") {
      UI.toast("Check in \"" + item.name + "\" before deleting it", "error");
      return;
    }
    var ok = confirm("Delete \"" + item.name + "\" (" + item.id + ")? This can't be undone.");
    if (!ok) return;
    var res = Store.deleteItem(id);
    if (res.ok) {
      render();
      UI.toast("Deleted " + item.name);
    } else {
      UI.toast("Couldn't delete that item", "error");
    }
  }

  /* ---------- Add / edit item dialog ---------- */

  var dialog = document.getElementById("item-dialog");
  var form = document.getElementById("item-form");
  var fName = document.getElementById("f-name");
  var fCategory = document.getElementById("f-category");
  var fId = document.getElementById("f-id");
  var fLocation = document.getElementById("f-location");
  var fQuantity = document.getElementById("f-quantity");
  var fQuantityField = document.getElementById("f-quantity-field");
  var fAliases = document.getElementById("f-aliases");
  var fNotes = document.getElementById("f-notes");
  var fRoles = document.getElementById("f-roles");
  var fRolesEmpty = document.getElementById("f-roles-empty");
  var fRolesField = document.getElementById("f-roles-field");
  var dialogTitle = document.getElementById("dialog-title");
  var editingId = null;

  var fTrackingMode = document.getElementById("f-tracking-mode");
  var fTrackingLockedNote = document.getElementById("f-tracking-locked-note");
  var fStockQtyField = document.getElementById("f-stock-qty-field");
  var fStockQty = document.getElementById("f-stock-qty");
  var fStockUnitField = document.getElementById("f-stock-unit-field");
  var fStockUnit = document.getElementById("f-stock-unit");
  var fStockMinField = document.getElementById("f-stock-min-field");
  var fStockMin = document.getElementById("f-stock-min");

  var fPhotoField = document.getElementById("f-photo-field");
  var fPhotoInput = document.getElementById("f-photo-input");
  var fPhotoPick = document.getElementById("f-photo-pick");
  var fPhotoRemove = document.getElementById("f-photo-remove");
  var fPhotoPreview = document.getElementById("f-photo-preview");
  var pendingPhoto = null;

  var fSerialField = document.getElementById("f-serial-field");
  var fSerial = document.getElementById("f-serial");
  var fConditionField = document.getElementById("f-condition-field");
  var fCondition = document.getElementById("f-condition");
  var fPurchaseDateField = document.getElementById("f-purchase-date-field");
  var fPurchaseDate = document.getElementById("f-purchase-date");
  var fPurchaseCostField = document.getElementById("f-purchase-cost-field");
  var fPurchaseCost = document.getElementById("f-purchase-cost");
  var fManualUrlField = document.getElementById("f-manual-url-field");
  var fManualUrl = document.getElementById("f-manual-url");

  var fStatusSection = document.getElementById("f-status-section");
  var fStatusSelect = document.getElementById("f-status-select");
  var fStatusApply = document.getElementById("f-status-apply");
  var fStatusLockedNote = document.getElementById("f-status-locked-note");
  var fHistoryNote = document.getElementById("f-history-note");
  var fHistoryAdd = document.getElementById("f-history-add");
  var fHistoryList = document.getElementById("f-history-list");

  Store.CONDITIONS.forEach(function (c) {
    var opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.label;
    fCondition.appendChild(opt);
  });

  ["ok", "maint", "fault"].forEach(function (key) {
    var opt = document.createElement("option");
    opt.value = key;
    opt.textContent = Store.STATUS[key].label;
    fStatusSelect.appendChild(opt);
  });

  function renderPhotoPreview() {
    if (pendingPhoto) {
      fPhotoPreview.innerHTML = '<img src="' + pendingPhoto + '" alt="" />';
      fPhotoRemove.hidden = false;
    } else {
      fPhotoPreview.innerHTML = '<span class="dim" style="font-size:.78rem">No photo</span>';
      fPhotoRemove.hidden = true;
    }
  }

  fPhotoPick.addEventListener("click", function () {
    fPhotoInput.click();
  });

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
        var maxDim = 640;
        var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * scale));
        var h = Math.max(1, Math.round(img.height * scale));
        var canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        pendingPhoto = canvas.toDataURL("image/jpeg", 0.72);
        renderPhotoPreview();
      };
      img.onerror = function () {
        UI.toast("Couldn't read that image", "error");
      };
      img.src = reader.result;
    };
    reader.onerror = function () {
      UI.toast("Couldn't read that image", "error");
    };
    reader.readAsDataURL(file);
  });

  function describeHistoryEntry(e) {
    return UI.describeLogEntry(e);
  }

  function renderHistory() {
    if (!editingId) {
      fHistoryList.innerHTML = "";
      return;
    }
    var entries = Store.itemHistory(editingId).slice(0, 25);
    if (!entries.length) {
      fHistoryList.innerHTML = '<li class="dim" style="padding:8px 0;font-size:.85rem;">No history yet.</li>';
      return;
    }
    fHistoryList.innerHTML = entries
      .map(function (e) {
        return (
          "<li><time>" + UI.timeAgo(e.ts) + "</time><div>" +
          '<div class="what">' + describeHistoryEntry(e) + "</div>" +
          "</div></li>"
        );
      })
      .join("");
  }

  function refreshStatusLock() {
    var item = editingId ? Store.getItem(editingId) : null;
    if (!item) return;
    var locked = item.status === "out";
    fStatusSelect.disabled = locked;
    fStatusApply.disabled = locked;
    if (locked) {
      var holder = item.holder ? Store.getEmployee(item.holder) : null;
      fStatusLockedNote.hidden = false;
      fStatusLockedNote.textContent = "Checked out to " + (holder ? holder.name : "someone") + " — check it in first to change status.";
    } else {
      fStatusLockedNote.hidden = true;
      fStatusSelect.value = item.status;
    }
  }

  fStatusApply.addEventListener("click", function () {
    if (!editingId) return;
    var note = fHistoryNote.value.trim();
    var res = Store.setItemStatus(editingId, fStatusSelect.value, note || null);
    if (res.ok) {
      fHistoryNote.value = "";
      renderHistory();
      refreshStatusLock();
      render();
      UI.toast("Status updated");
    } else if (res.reason === "checked-out") {
      UI.toast("Check the item in before changing its status", "error");
    } else {
      UI.toast("Couldn't update status", "error");
    }
  });

  fHistoryAdd.addEventListener("click", function () {
    if (!editingId) return;
    var note = fHistoryNote.value.trim();
    if (!note) {
      UI.toast("Write a note first", "error");
      return;
    }
    var res = Store.addMaintenanceNote(editingId, note);
    if (res.ok) {
      fHistoryNote.value = "";
      renderHistory();
      UI.toast("Note added");
    }
  });

  function updateTrackingUI() {
    var isConsumable = fTrackingMode.value === "consumable";
    var isEditing = !!editingId;
    fQuantityField.hidden = isConsumable || isEditing;
    fStockQtyField.hidden = !isConsumable;
    fStockUnitField.hidden = !isConsumable;
    fStockMinField.hidden = !isConsumable;
    fPhotoField.hidden = isConsumable;
    fSerialField.hidden = isConsumable;
    fConditionField.hidden = isConsumable;
    fPurchaseDateField.hidden = isConsumable;
    fPurchaseCostField.hidden = isConsumable;
    fManualUrlField.hidden = isConsumable;
    fRolesField.hidden = false;
    fStatusSection.hidden = isConsumable || !isEditing;
    fTrackingLockedNote.hidden = !isEditing;
  }

  fTrackingMode.addEventListener("change", updateTrackingUI);

  function populateRoleChecks(selectedIds) {
    var roles = Store.getRoles();
    var selected = Array.isArray(selectedIds) ? selectedIds : [];
    fRolesEmpty.hidden = roles.length > 0;
    fRoles.innerHTML = roles
      .map(function (r) {
        var checked = selected.indexOf(r.id) > -1 ? " checked" : "";
        return (
          '<label class="role-check"><input type="checkbox" value="' + UI.esc(r.id) + '"' + checked + " />" +
          UI.esc(r.name) + "</label>"
        );
      })
      .join("");
  }

  function selectedRoleIds() {
    return Array.prototype.slice
      .call(fRoles.querySelectorAll("input:checked"))
      .map(function (cb) {
        return cb.value;
      });
  }

  Store.CATEGORIES.forEach(function (c) {
    var opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    fCategory.appendChild(opt);
  });

  function populateLocationOptions(selected) {
    var locations = Store.getLocations();
    fLocation.innerHTML = locations
      .map(function (l) {
        return '<option value="' + UI.esc(l) + '">' + UI.esc(l) + "</option>";
      })
      .join("");
    if (selected && locations.indexOf(selected) === -1) {
      var opt = document.createElement("option");
      opt.value = selected;
      opt.textContent = selected;
      fLocation.appendChild(opt);
    }
    fLocation.value = selected || locations[0] || "";
  }

  function openItemDialog(existing) {
    editingId = existing ? existing.id : null;
    dialogTitle.textContent = existing ? "Edit item" : "Add item";
    fName.value = existing ? existing.name : "";
    fCategory.value = existing ? existing.category : Store.CATEGORIES[0];
    populateLocationOptions(existing ? existing.location : null);
    fAliases.value = existing ? existing.aliases || "" : "";
    fNotes.value = existing ? existing.notes || "" : "";
    populateRoleChecks(existing ? existing.restrictedTo : []);
    fId.value = existing ? existing.id : Store.nextItemId(fCategory.value);
    fId.readOnly = !!existing;
    document.getElementById("f-id-regen").hidden = !!existing;
    fQuantity.value = "1";

    fTrackingMode.value = existing ? (existing.trackingMode || "unit") : "unit";
    fTrackingMode.disabled = !!existing;

    pendingPhoto = existing ? existing.photo || null : null;
    fPhotoInput.value = "";
    renderPhotoPreview();
    fSerial.value = existing ? existing.serial || "" : "";
    fCondition.value = existing ? existing.condition || "good" : "good";
    fPurchaseDate.value = existing ? existing.purchaseDate || "" : "";
    fPurchaseCost.value = existing && existing.purchaseCost != null ? existing.purchaseCost : "";
    fManualUrl.value = existing ? existing.manualUrl || "" : "";

    fStockQty.value = existing && existing.quantity != null ? existing.quantity : 0;
    fStockUnit.value = existing ? existing.unitLabel || "" : "";
    fStockMin.value = existing && existing.minQuantity != null ? existing.minQuantity : 0;

    updateTrackingUI();
    if (existing && (existing.trackingMode || "unit") === "unit") {
      refreshStatusLock();
      renderHistory();
      fHistoryNote.value = "";
    }

    document.getElementById("save-btn").textContent = existing ? "Save changes" : "Save item";
    document.getElementById("delete-btn").hidden = !existing;
    dialog.showModal();
    fName.focus();
  }

  document.getElementById("add-item-btn").addEventListener("click", function () {
    openItemDialog(null);
  });

  document.getElementById("cancel-btn").addEventListener("click", function () {
    dialog.close();
  });

  document.getElementById("delete-btn").addEventListener("click", function () {
    if (!editingId) return;
    dialog.close();
    confirmDelete(editingId);
  });

  fCategory.addEventListener("change", function () {
    if (!editingId) {
      fId.value = Store.nextItemId(fCategory.value);
      if (fCategory.value === "Consumables" && fTrackingMode.value !== "consumable") {
        fTrackingMode.value = "consumable";
        updateTrackingUI();
      }
    }
  });

  document.getElementById("f-id-regen").addEventListener("click", function () {
    fId.value = Store.nextItemId(fCategory.value);
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var id = fId.value.trim().toUpperCase();
    if (!id || !fName.value.trim()) return;

    var isConsumable = fTrackingMode.value === "consumable";

    if (editingId) {
      var item = Store.getItem(editingId);
      item.id = id;
      item.name = fName.value.trim();
      item.category = fCategory.value;
      item.location = fLocation.value;
      item.aliases = fAliases.value.trim();
      item.notes = fNotes.value.trim();
      item.restrictedTo = selectedRoleIds();

      if (item.trackingMode === "consumable") {
        item.unitLabel = fStockUnit.value.trim();
        item.minQuantity = Math.max(0, parseInt(fStockMin.value, 10) || 0);
        var newQty = Math.max(0, parseInt(fStockQty.value, 10) || 0);
        var oldQty = item.quantity || 0;
        Store.saveItem(item);
        if (newQty !== oldQty) {
          Store.adjustQuantity(item.id, newQty - oldQty, "Manual correction");
        }
      } else {
        item.photo = pendingPhoto;
        item.serial = fSerial.value.trim();
        item.condition = fCondition.value;
        item.purchaseDate = fPurchaseDate.value || "";
        item.purchaseCost = fPurchaseCost.value === "" ? null : parseFloat(fPurchaseCost.value);
        item.manualUrl = fManualUrl.value.trim();
        Store.saveItem(item);
      }

      dialog.close();
      render();
      UI.toast("Item updated");
      return;
    }

    if (isConsumable) {
      if (Store.getItem(id)) {
        UI.toast("That tag ID is already in use", "error");
        return;
      }
      var newConsumable = {
        id: id, status: "ok", holder: null, due: null,
        trackingMode: "consumable",
        name: fName.value.trim(),
        category: fCategory.value,
        location: fLocation.value,
        aliases: fAliases.value.trim(),
        notes: fNotes.value.trim(),
        restrictedTo: selectedRoleIds(),
        quantity: Math.max(0, parseInt(fStockQty.value, 10) || 0),
        unitLabel: fStockUnit.value.trim() || "units",
        minQuantity: Math.max(0, parseInt(fStockMin.value, 10) || 0)
      };
      Store.saveItem(newConsumable);
      Store.addLog({ type: "add", itemId: newConsumable.id, itemName: newConsumable.name, empName: "" });
      dialog.close();
      render();
      UI.toast("Consumable added — generate a barcode for the bin if you'd like");
      openBarcode(newConsumable.id);
      return;
    }

    var qty = Math.max(1, Math.min(50, parseInt(fQuantity.value, 10) || 1));
    var unitFields = {
      trackingMode: "unit",
      photo: pendingPhoto,
      serial: fSerial.value.trim(),
      condition: fCondition.value,
      purchaseDate: fPurchaseDate.value || "",
      purchaseCost: fPurchaseCost.value === "" ? null : parseFloat(fPurchaseCost.value),
      manualUrl: fManualUrl.value.trim()
    };

    if (qty === 1) {
      if (Store.getItem(id)) {
        UI.toast("That tag ID is already in use", "error");
        return;
      }
      var newItem = Object.assign({
        id: id, status: "ok", holder: null, due: null,
        name: fName.value.trim(),
        category: fCategory.value,
        location: fLocation.value,
        aliases: fAliases.value.trim(),
        notes: fNotes.value.trim(),
        restrictedTo: selectedRoleIds()
      }, unitFields);
      Store.saveItem(newItem);
      Store.addLog({ type: "add", itemId: newItem.id, itemName: newItem.name, empName: "" });
      dialog.close();
      render();
      UI.toast("Item added — generate its barcode when ready");
      openBarcode(newItem.id);
      return;
    }

    // Multiple units of the same item: LX-0002-1, LX-0002-2, ...
    if (Store.itemsInGroup(id).length) {
      UI.toast("That tag ID is already in use", "error");
      return;
    }
    var created = [];
    for (var i = 1; i <= qty; i++) {
      var unitId = id + "-" + i;
      if (Store.getItem(unitId)) {
        UI.toast("A tag ID for one of these units is already in use", "error");
        return;
      }
      created.push(Object.assign({
        id: unitId, groupId: id, status: "ok", holder: null, due: null,
        name: fName.value.trim(),
        category: fCategory.value,
        location: fLocation.value,
        aliases: fAliases.value.trim(),
        notes: fNotes.value.trim(),
        restrictedTo: selectedRoleIds()
      }, unitFields));
    }
    created.forEach(function (unit) {
      Store.saveItem(unit);
      Store.addLog({ type: "add", itemId: unit.id, itemName: unit.name, empName: "" });
    });
    expandedGroups[id] = true;
    dialog.close();
    render();
    UI.toast(qty + " units added — generate their barcodes when ready");
    openBarcode(created[0].id);
  });

  /* ---------- Stock adjustment dialog ---------- */

  var stockDialog = document.getElementById("stock-dialog");
  var stockForm = document.getElementById("stock-form");
  var stockAmount = document.getElementById("stock-amount");
  var stockNote = document.getElementById("stock-note");
  var stockSub = document.getElementById("stock-dialog-sub");
  var stockTitle = document.getElementById("stock-dialog-title");
  var stockUseBtn = document.getElementById("stock-use-btn");
  var stockItemId = null;

  function openStockDialog(id) {
    var item = Store.getItem(id);
    if (!item) return;
    stockItemId = id;
    stockTitle.textContent = "Adjust stock — " + item.name;
    stockSub.textContent = "Currently " + (item.quantity || 0) + " " + (item.unitLabel || "units") + " on hand.";
    stockAmount.value = "1";
    stockNote.value = "";
    stockDialog.showModal();
    stockAmount.focus();
  }

  function applyStockChange(sign) {
    var amt = Math.max(1, parseInt(stockAmount.value, 10) || 1);
    var note = stockNote.value.trim();
    var res = Store.adjustQuantity(stockItemId, sign * amt, note || null);
    if (res.ok) {
      stockDialog.close();
      render();
      UI.toast(sign > 0 ? "Restocked" : "Usage logged");
    } else if (res.reason === "insufficient-stock") {
      UI.toast("Not enough stock for that", "error");
    } else {
      UI.toast("Couldn't update stock", "error");
    }
  }

  stockForm.addEventListener("submit", function (e) {
    e.preventDefault();
    applyStockChange(1);
  });

  stockUseBtn.addEventListener("click", function () {
    applyStockChange(-1);
  });

  document.getElementById("stock-cancel-btn").addEventListener("click", function () {
    stockDialog.close();
  });

  /* ---------- Barcode dialog ---------- */

  var bcDialog = document.getElementById("barcode-dialog");
  var bcName = document.getElementById("bc-name");
  var bcId = document.getElementById("bc-id");
  var bcSvg = document.getElementById("bc-svg");

  function openBarcode(itemId) {
    var item = Store.getItem(itemId);
    if (!item) return;
    bcName.textContent = item.name;
    bcId.textContent = item.id;
    try {
      JsBarcode(bcSvg, item.id, {
        format: "CODE128",
        lineColor: "#111",
        background: "#ffffff",
        width: 2,
        height: 64,
        displayValue: false,
        margin: 6
      });
    } catch (e) {
      console.error("Barcode render failed", e);
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
