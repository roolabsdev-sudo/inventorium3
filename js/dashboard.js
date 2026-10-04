(function () {
  "use strict";

  Store.init();
  UI.buildRail("index.html");

  function render() {
    var counts = Store.counts();
    var total = counts.ok + counts.out + counts.maint + counts.fault;
    var lowStock = Store.lowStockItems();
    document.getElementById("readouts").innerHTML =
      readout("total", total, "Items on hand") +
      readout("ok", counts.ok, "Available") +
      readout("out", counts.out, "Checked out") +
      readout("maint", counts.maint, "In maintenance") +
      readout("fault", counts.fault, "Damaged or missing") +
      readout("low", lowStock.length, "Consumables low");

    var lowRows = document.getElementById("lowstock-rows");
    if (!lowStock.length) {
      lowRows.innerHTML = '<tr><td colspan="3" class="dim" style="padding:24px 16px">All consumables are stocked up.</td></tr>';
    } else {
      lowRows.innerHTML = lowStock
        .map(function (it) {
          var level = Store.stockLevel(it);
          var cls = level === "out" ? "badge-fault" : "badge-maint";
          var label = level === "out" ? "Out of stock" : "Low stock";
          return (
            "<tr>" +
            '<td><span class="item-name">' + UI.esc(it.name) + '</span><span class="item-loc">' + UI.esc(it.id) + "</span></td>" +
            "<td>" + (it.quantity || 0) + " " + UI.esc(it.unitLabel || "units") + "</td>" +
            '<td><span class="badge ' + cls + '">' + label + "</span></td>" +
            "</tr>"
          );
        })
        .join("");
    }

    var outItems = Store.getItems().filter(function (it) {
      return it.status === "out";
    });
    var outRows = document.getElementById("out-rows");
    if (!outItems.length) {
      outRows.innerHTML = '<tr><td colspan="3" class="dim" style="padding:24px 16px">Nothing checked out right now.</td></tr>';
    } else {
      outRows.innerHTML = outItems
        .map(function (it) {
          var holder = it.holder ? Store.getEmployee(it.holder) : null;
          return (
            "<tr>" +
            '<td><span class="item-name">' + UI.esc(it.name) + '</span><span class="item-loc">' + UI.esc(it.id) + "</span></td>" +
            "<td>" + (holder ? UI.esc(holder.name) : "Unknown") + "</td>" +
            '<td><span class="badge badge-out">Checked out</span></td>' +
            "</tr>"
          );
        })
        .join("");
    }

    var feed = Store.getLog().slice(0, 8);
    var feedEl = document.getElementById("feed");
    if (!feed.length) {
      feedEl.innerHTML = '<li><span class="dim" style="padding:4px 0">No activity yet. Scan something to get started.</span></li>';
    } else {
      feedEl.innerHTML = feed
        .map(function (e) {
          var text = UI.describeLogEntry(e);
          return (
            "<li><time>" + UI.timeAgo(e.ts) + "</time><div>" +
            '<div class="what">' + text + "</div>" +
            '<div class="who">' + UI.esc(e.empName || "—") + "</div>" +
            "</div></li>"
          );
        })
        .join("");
    }
  }

  function readout(ch, value, label) {
    return (
      '<div class="readout" data-ch="' + ch + '">' +
      '<div class="value mono">' + value + "</div>" +
      '<div class="label">' + label + "</div>" +
      "</div>"
    );
  }

  render();
})();
