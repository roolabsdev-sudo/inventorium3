(function () {
  "use strict";

  Store.init();
  UI.buildRail("scan.html");

  var stateEl = document.getElementById("scan-state");
  var hintEl = document.getElementById("scan-hint");
  var sessionBody = document.getElementById("session-body");
  var resultBody = document.getElementById("result-body");
  var sessionLogEl = document.getElementById("session-log");
  var torchBtn = document.getElementById("torch-btn");

  var currentEmployee = null; // full employee object once scanned
  var sessionEntries = []; // { time, text, detail }
  var torchOn = false;

  /* ---------- Quantity control (for consumables, so several units can be logged in one scan) ---------- */

  var qtyInput = document.getElementById("qty-input");

  function getScanQty() {
    var n = parseInt(qtyInput.value, 10);
    if (isNaN(n) || n < 1) n = 1;
    return n;
  }

  function setScanQty(n) {
    qtyInput.value = Math.max(1, n);
  }

  document.getElementById("qty-minus").addEventListener("click", function () {
    setScanQty(getScanQty() - 1);
  });
  document.getElementById("qty-plus").addEventListener("click", function () {
    setScanQty(getScanQty() + 1);
  });
  qtyInput.addEventListener("change", function () {
    setScanQty(getScanQty());
  });

  function roleName(roleId) {
    var role = roleId ? Store.getRole(roleId) : null;
    return role ? role.name : "";
  }

  /* ---------- Session UI ---------- */

  function renderSession() {
    if (!currentEmployee) {
      sessionBody.innerHTML = '<p class="dim">Scan an employee ID to start. Every item scanned after that checks in or out under their name.</p>';
      return;
    }
    sessionBody.innerHTML =
      '<div style="display:flex; align-items:center; gap:12px;">' +
      '<div style="width:40px;height:40px;border-radius:50%;background:var(--panel-raised);border:1px solid var(--edge-strong);display:flex;align-items:center;justify-content:center;font-weight:600;color:var(--tungsten);">' +
      UI.esc(currentEmployee.name.charAt(0)) +
      "</div>" +
      "<div>" +
      '<div class="item-name">' + UI.esc(currentEmployee.name) + "</div>" +
      '<div class="dim mono" style="font-size:.82rem">' + UI.esc(currentEmployee.id) + " · " + UI.esc(roleName(currentEmployee.roleId)) + "</div>" +
      "</div></div>" +
      '<p class="dim" style="margin-top:12px">Now scan item tags. Available items check out to ' + UI.esc(currentEmployee.name.split(" ")[0]) + "; items already out check back in.</p>";
  }

  function renderResult(kind, title, subtitle, detail) {
    var color = kind === "error" ? "var(--fault)" : kind === "warn" ? "var(--warn)" : "var(--ok)";
    resultBody.innerHTML =
      '<div style="border-left:3px solid ' + color + '; padding-left:12px;">' +
      '<div class="item-name">' + title + "</div>" +
      (subtitle ? '<div class="dim" style="font-size:.9rem; margin-top:2px">' + subtitle + "</div>" : "") +
      (detail ? '<div class="dim" style="font-size:.82rem; margin-top:6px">' + detail + "</div>" : "") +
      "</div>";
  }

  function addSessionEntry(text, detail) {
    sessionEntries.unshift({ time: UI.clockTime(Date.now()), text: text, detail: detail });
    sessionLogEl.innerHTML = sessionEntries
      .map(function (e) {
        return (
          "<li><time>" + e.time + "</time><div><div class=\"what\">" + e.text + "</div>" +
          (e.detail ? '<div class="who">' + e.detail + "</div>" : "") + "</div></li>"
        );
      })
      .join("");
  }

  document.getElementById("end-session").addEventListener("click", function () {
    currentEmployee = null;
    renderSession();
    renderResult("ok", "Session ended", "Scan an employee ID to start a new one.");
    UI.toast("Session ended");
  });

  /* ---------- Core handling of any scanned/typed code ---------- */

  function handleCode(raw) {
    var code = String(raw || "").trim().toUpperCase();
    if (!code) return;

    // Employee ID scanned
    var emp = Store.getEmployee(code);
    if (emp) {
      if (!emp.active) {
        renderResult("error", code, "This employee ID is inactive.", "Ask an advisor to reactivate it in Employees.");
        UI.toast("Inactive employee ID", "error");
        return;
      }
      currentEmployee = emp;
      renderSession();
      renderResult("ok", emp.name, "Session started", roleName(emp.roleId));
      addSessionEntry("Session started for " + emp.name, code);
      UI.toast("Hi, " + emp.name.split(" ")[0]);
      return;
    }

    // Item tag scanned
    var item = Store.getItem(code);
    if (item) {
      if (!currentEmployee) {
        renderResult("warn", item.name, "Scan an employee ID first", "Items can't check out without a crew member attached to the session.");
        UI.toast("Scan an employee ID first", "warn");
        return;
      }

      if (item.trackingMode === "consumable") {
        var qty = getScanQty();
        var use = Store.useConsumable(item.id, currentEmployee.id, qty);
        if (use.ok) {
          var unitLabel = use.item.unitLabel || "unit" + (qty === 1 ? "" : "s");
          renderResult("ok", item.name, "Used " + qty + " " + unitLabel, use.item.quantity + " " + unitLabel + " remaining");
          addSessionEntry("Used " + item.name, qty + " " + unitLabel + " → " + currentEmployee.name);
          UI.toast(item.name + " logged (" + qty + ")");
          if (Store.stockLevel(use.item) !== "ok") {
            UI.toast(item.name + " is running low", "warn");
          }
          setScanQty(1);
        } else if (use.reason === "restricted") {
          var allowedStockNames = (item.restrictedTo || [])
            .map(roleName)
            .filter(Boolean)
            .join(", ");
          renderResult(
            "error",
            item.name,
            "Restricted item — " + currentEmployee.name.split(" ")[0] + " isn't cleared for this",
            allowedStockNames ? "Only " + allowedStockNames + " can use this." : "This item is restricted."
          );
          addSessionEntry("Blocked — " + item.name + " is restricted", item.id + " · " + currentEmployee.name);
          UI.toast(item.name + " is restricted for this role", "error");
        } else if (use.reason === "insufficient-stock") {
          var haveQty = use.item ? (use.item.quantity || 0) : 0;
          renderResult(
            "error",
            item.name,
            "Not enough on hand for " + qty,
            "Only " + haveQty + " " + (use.item ? use.item.unitLabel || "units" : "units") + " left — restock in Inventory, or lower the Qty above."
          );
          UI.toast("Only " + haveQty + " " + item.name + " left", "error");
        } else {
          renderResult("error", item.name, "Couldn't log usage", use.reason);
        }
        return;
      }

      if (item.status === "out") {
        // Check in — but if someone else has it, confirm it's really coming back now.
        var res = Store.checkIn(item.id);
        if (res.ok) {
          renderResult("ok", item.name, "Checked in", item.id + " · back from " + (res.previousHolderName || "unknown"));
          addSessionEntry("Checked in " + item.name, item.id);
          UI.toast(item.name + " checked in");
        }
        return;
      }

      if (item.status === "maint" || item.status === "fault") {
        var label = item.status === "maint" ? "in maintenance" : "flagged as damaged";
        renderResult("error", item.name, "Not available — " + label, item.notes ? UI.esc(item.notes) : "See Inventory for details.");
        UI.toast(item.name + " is " + label, "error");
        return;
      }

      // Available — check out to current employee
      var out = Store.checkOut(item.id, currentEmployee.id);
      if (out.ok) {
        renderResult("ok", item.name, "Checked out to " + currentEmployee.name, item.id);
        addSessionEntry("Checked out " + item.name, item.id + " → " + currentEmployee.name);
        UI.toast(item.name + " checked out");
      } else if (out.reason === "restricted") {
        var allowedNames = (item.restrictedTo || [])
          .map(roleName)
          .filter(Boolean)
          .join(", ");
        renderResult(
          "error",
          item.name,
          "Restricted item — " + currentEmployee.name.split(" ")[0] + " isn't cleared for this",
          allowedNames ? "Only " + allowedNames + " can check this out." : "This item is restricted."
        );
        addSessionEntry("Blocked — " + item.name + " is restricted", item.id + " · " + currentEmployee.name);
        UI.toast(item.name + " is restricted for this role", "error");
      } else {
        renderResult("error", item.name, "Couldn't check out", out.reason);
      }
      return;
    }

    // Nothing matched
    renderResult("error", code, "No match found", "This isn't a known employee ID or item tag. Check Inventory or Employees to add it.");
    UI.toast("No match for " + code, "error");
  }

  document.getElementById("manual-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var input = document.getElementById("manual-input");
    handleCode(input.value);
    input.value = "";
    input.focus();
  });

  /* ---------- Camera wiring ---------- */

  var video = document.getElementById("video");
  video.dataset.fallbackContainer = "fallback-container";

  var scanner = new CameraScanner(
    video,
    function onDetect(value) {
      handleCode(value);
    },
    function onError(reason) {
      var messages = {
        "no-camera-api": "This browser doesn't support camera access. Use manual entry below.",
        "camera-denied": "Camera access was denied. Allow it in your browser, or use manual entry below.",
        "fallback-load-failed": "Couldn't load the scanner library. Check your connection or use manual entry below."
      };
      hintEl.textContent = messages[reason] || "Camera unavailable. Use manual entry below.";
      stateEl.className = "badge badge-fault";
      stateEl.textContent = "Camera off";
      document.getElementById("manual-input").focus();
    }
  );

  scanner.start().then(function () {
    if (scanner.running) {
      stateEl.className = "badge badge-ok";
      stateEl.textContent = "Live";
      hintEl.textContent = "Hold a tag or ID inside the frame";
      video.style.display = scanner.mode === "native" ? "block" : "none";

      if (scanner.mode === "native" && scanner.stream) {
        var track = scanner.stream.getVideoTracks()[0];
        var caps = track.getCapabilities ? track.getCapabilities() : {};
        if (caps.torch) torchBtn.hidden = false;
      }
    }
  });

  torchBtn.addEventListener("click", async function () {
    torchOn = !torchOn;
    var ok = await scanner.setTorch(torchOn);
    if (ok) {
      torchBtn.classList.toggle("btn-primary", torchOn);
    } else {
      torchOn = false;
      UI.toast("Torch not available on this device", "warn");
    }
  });

  window.addEventListener("beforeunload", function () {
    scanner.stop();
  });
})();
