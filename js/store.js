/**
 * Inventorium data store — cloud edition.
 *
 * Same method names and synchronous behaviour the pages always used, but the
 * data now lives in Supabase behind Netlify Functions:
 *
 *   - Store.load() (called once by boot.js) fetches everything the signed-in
 *     person is allowed to see into an in-memory cache.
 *   - Reads (getItems, getEmployee, ...) are served from that cache, instantly.
 *   - Writes update the cache immediately and are sent to the server in order.
 *     The SERVER is the authority: it re-checks permissions and business rules
 *     (restricted items, already-checked-out, ...). If it rejects a write, the
 *     person sees the reason and the page reloads with the true data.
 *
 * Permissions: Store.can("inventory" | "callList" | "employees" | "settings",
 * "view" | "edit"). Write methods refuse (and say so) without 'edit'.
 */
(function (global) {
  "use strict";

  var FN = "/.netlify/functions/";

  var cache = {
    items: [], employees: [], roles: [], locations: [],
    showRoles: [], shows: [], callEntries: [], log: []
  };
  var me = null;

  var CATEGORIES = ["Lighting", "Audio", "Video", "Rigging", "Cables", "Tools", "Consumables", "Other"];
  var STATUS = {
    ok: { label: "Available", cls: "badge-ok" },
    out: { label: "Checked out", cls: "badge-out" },
    maint: { label: "In maintenance", cls: "badge-maint" },
    fault: { label: "Damaged", cls: "badge-fault" }
  };
  var CONDITIONS = [
    { id: "good", label: "Good" },
    { id: "fair", label: "Fair" },
    { id: "poor", label: "Poor" }
  ];
  var AREA_KEY = { inventory: "permInventory", callList: "permCallList", employees: "permEmployees", settings: "permSettings" };

  function uid(prefix) {
    return prefix + "-" + Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 5);
  }
  function pad(n) {
    return String(n).padStart(4, "0");
  }

  /* ---------- Server plumbing ---------- */

  function goToLogin() {
    var next = location.pathname.split("/").pop() || "index.html";
    location.replace("login.html?next=" + encodeURIComponent(next));
  }

  function api(method, fn, query, body) {
    var user = global.netlifyIdentity && global.netlifyIdentity.currentUser();
    if (!user) {
      goToLogin();
      return Promise.reject(new Error("Not logged in."));
    }
    return user.jwt().then(function (token) {
      var url = FN + fn + (query ? "?" + query : "");
      return fetch(url, {
        method: method,
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    }).then(function (res) {
      return res.text().then(function (text) {
        var json = null;
        try { json = text ? JSON.parse(text) : {}; } catch (e) { json = {}; }
        if (!res.ok) {
          var err = new Error(json.error || ("Request failed (" + res.status + ")"));
          err.status = res.status;
          throw err;
        }
        return json;
      });
    });
  }

  var chain = Promise.resolve();
  var pending = 0;

  // Fire-and-forget write, strictly ordered. On failure: explain, then reload true data.
  function send(method, fn, query, body) {
    pending++;
    chain = chain.then(function () {
      return api(method, fn, query, body);
    }).catch(function (err) {
      if (err.status === 401) { goToLogin(); return; }
      if (global.UI) UI.toast(err.message, "error");
      else alert(err.message);
      setTimeout(function () { location.reload(); }, 2200);
    }).then(function () {
      pending--;
    });
    return chain;
  }

  function guard(area) {
    if (Store.can(area, "edit")) return true;
    if (global.UI) UI.toast("You have view-only access here.", "warn");
    return false;
  }

  /* ---------- Row <-> app-shape mapping ---------- */

  function level(v) { return v === "edit" || v === "view" ? v : "none"; }

  function empFromRow(r) {
    return {
      id: r.id, name: r.name, roleId: r.role_id || null, active: r.active !== false,
      photo: r.photo || null, email: r.email || "",
      permInventory: level(r.perm_inventory), permCallList: level(r.perm_call_list),
      permEmployees: level(r.perm_employees), permSettings: level(r.perm_settings)
    };
  }
  function itemFromRow(r) {
    var it = {
      id: r.id, name: r.name, category: r.category || "", location: r.location || "",
      status: r.status || "ok", holder: r.holder || null,
      due: r.due ? Date.parse(r.due) : null,
      aliases: r.aliases || "", notes: r.notes || "",
      restrictedTo: Array.isArray(r.restricted_to) ? r.restricted_to : [],
      photo: r.photo || null, serial: r.serial || "", condition: r.condition || "",
      purchaseDate: r.purchase_date || "",
      purchaseCost: r.purchase_cost == null ? null : Number(r.purchase_cost),
      manualUrl: r.manual_url || ""
    };
    if (r.group_id) it.groupId = r.group_id;
    if (r.tracking_mode === "consumable") {
      it.trackingMode = "consumable";
      it.quantity = Number(r.quantity) || 0;
      it.unitLabel = r.unit_label || "";
      it.minQuantity = Number(r.min_quantity) || 0;
    }
    return it;
  }
  function entryFromRow(r) {
    return { id: r.id, showId: r.show_id, empId: r.emp_id, showRoleId: r.show_role_id || null, comm: !!r.comm };
  }
  function logFromRow(r) {
    return {
      id: r.id, ts: Date.parse(r.ts), type: r.type, itemId: r.item_id, itemName: r.item_name,
      empId: r.emp_id, empName: r.emp_name, note: r.note
    };
  }
  function plain(r) { return { id: r.id, name: r.name }; }

  function hydrate(d) {
    me = empFromRow(d.me);
    cache.items = (d.items || []).map(itemFromRow);
    cache.employees = (d.employees || []).map(empFromRow);
    cache.roles = (d.roles || []).map(plain);
    cache.locations = (d.locations || []).map(plain);
    cache.showRoles = (d.showRoles || []).map(plain);
    cache.shows = (d.shows || []).map(plain);
    cache.callEntries = (d.callList || []).map(entryFromRow);
    cache.log = (d.log || []).map(logFromRow);
    if (d.branding && global.Branding) global.Branding.set(d.branding); // this venue's name and logo
  }

  function replaceIn(list, obj) {
    var idx = list.findIndex(function (x) { return x.id === obj.id; });
    if (idx > -1) list[idx] = obj; else list.push(obj);
  }
  function byName(a, b) { return a.name.localeCompare(b.name); }

  /* ---------- Public API ---------- */

  var Store = {
    CATEGORIES: CATEGORIES,
    STATUS: STATUS,
    CONDITIONS: CONDITIONS,

    /* ----- session / permissions ----- */
    init: function () {}, // kept so page scripts that call it still work; boot.js loads the data
    load: function () {
      return api("GET", "bootstrap").then(function (d) { hydrate(d); return Store; });
    },
    refresh: function () {
      if (pending) return Promise.resolve();
      return api("GET", "bootstrap").then(function (d) { hydrate(d); });
    },
    hasPending: function () { return pending > 0; },
    getMe: function () { return me; },
    can: function (area, min) {
      if (!me) return false;
      var lv = me[AREA_KEY[area]] || "none";
      return min === "edit" ? lv === "edit" : (lv === "view" || lv === "edit");
    },
    firstAllowedPage: function () {
      var pages = [
        ["index.html", "inventory"], ["inventory.html", "inventory"], ["call-list.html", "callList"],
        ["employees.html", "employees"], ["settings.html", "settings"]
      ];
      for (var i = 0; i < pages.length; i++) if (this.can(pages[i][1], "view")) return pages[i][0];
      return null;
    },

    /* ----- locations (cache holds {id,name}; pages use plain names) ----- */
    getLocations: function () {
      return cache.locations.map(function (l) { return l.name; });
    },
    saveLocation: function (oldName, newName) {
      newName = String(newName || "").trim();
      if (!newName) return { ok: false, reason: "empty" };
      if (!guard("settings")) return { ok: false, reason: "read-only" };
      var dup = cache.locations.some(function (l) {
        return l.name.toLowerCase() === newName.toLowerCase() && l.name !== oldName;
      });
      if (dup) return { ok: false, reason: "duplicate" };
      var row;
      if (oldName) {
        row = cache.locations.find(function (l) { return l.name === oldName; });
        if (!row) return { ok: false, reason: "not-found" };
        row.name = newName;
        if (oldName !== newName) {
          cache.items.forEach(function (it) { if (it.location === oldName) it.location = newName; });
        }
      } else {
        row = { id: uid("loc"), name: newName };
        cache.locations.push(row);
      }
      send("POST", "settings", "resource=locations", { id: row.id, name: newName });
      return { ok: true, name: newName };
    },
    deleteLocation: function (name) {
      if (!guard("settings")) return { ok: false, reason: "read-only" };
      var inUse = cache.items.some(function (it) { return it.location === name; });
      if (inUse) return { ok: false, reason: "in-use" };
      var row = cache.locations.find(function (l) { return l.name === name; });
      if (!row) return { ok: true };
      cache.locations = cache.locations.filter(function (l) { return l !== row; });
      send("DELETE", "settings", "resource=locations&id=" + encodeURIComponent(row.id));
      return { ok: true };
    },

    /* ----- items ----- */
    getItems: function () { return cache.items; },
    getItem: function (id) {
      return cache.items.find(function (it) { return it.id === id; }) || null;
    },
    saveItem: function (item) {
      if (!guard("inventory")) return item;
      replaceIn(cache.items, item);
      send("POST", "items", "", item);
      return item;
    },
    deleteItem: function (id) {
      var item = this.getItem(id);
      if (!item) return { ok: false, reason: "not-found" };
      if (item.status === "out") return { ok: false, reason: "checked-out", item: item };
      if (!guard("inventory")) return { ok: false, reason: "read-only" };
      cache.items = cache.items.filter(function (it) { return it.id !== id; });
      this.addLog({ type: "delete", itemId: item.id, itemName: item.name, empName: "" });
      send("DELETE", "items", "id=" + encodeURIComponent(id));
      return { ok: true };
    },
    nextItemId: function (category) {
      var prefixMap = {
        Lighting: "LX", Audio: "AU", Video: "VD", Rigging: "RG",
        Cables: "CB", Tools: "TL", Consumables: "CN", Other: "OT"
      };
      var prefix = prefixMap[category] || "IT";
      var max = 0;
      cache.items.forEach(function (it) {
        if (it.id.indexOf(prefix + "-") === 0) {
          var n = parseInt(it.id.split("-")[1], 10);
          if (!isNaN(n) && n > max) max = n;
        }
      });
      return prefix + "-" + pad(max + 1);
    },

    /* Multiple units of the same item, e.g. LX-0002-1, LX-0002-2 ... */
    groupIdOf: function (item) { return item && (item.groupId || item.id); },
    itemsInGroup: function (groupId) {
      return cache.items.filter(function (it) { return (it.groupId || it.id) === groupId; });
    },
    groupAvailability: function (groupId) {
      var items = this.itemsInGroup(groupId);
      var available = items.filter(function (it) { return it.status === "ok"; }).length;
      return { total: items.length, available: available };
    },
    nextUnitSuffix: function (groupId) {
      var max = 0;
      var prefix = groupId + "-";
      this.itemsInGroup(groupId).forEach(function (it) {
        if (it.id.indexOf(prefix) === 0) {
          var rest = it.id.slice(prefix.length);
          var n = parseInt(rest, 10);
          if (!isNaN(n) && String(n) === rest && n > max) max = n;
        }
      });
      return max + 1;
    },
    addUnit: function (groupId) {
      var items = this.itemsInGroup(groupId);
      if (!items.length) return { ok: false, reason: "not-found" };
      if (!guard("inventory")) return { ok: false, reason: "read-only" };
      var template = items[0];
      var id = groupId + "-" + this.nextUnitSuffix(groupId);
      if (this.getItem(id)) return { ok: false, reason: "exists" };
      var item = {
        id: id, groupId: groupId, status: "ok", holder: null, due: null,
        name: template.name, category: template.category, location: template.location,
        aliases: template.aliases, notes: template.notes,
        restrictedTo: (template.restrictedTo || []).slice()
      };
      this.saveItem(item);
      this.addLog({ type: "add", itemId: item.id, itemName: item.name, empName: "" });
      return { ok: true, item: item };
    },

    /* ----- employees ----- */
    getEmployees: function () { return cache.employees; },
    getEmployee: function (id) {
      return cache.employees.find(function (e) { return e.id === id; }) || null;
    },
    saveEmployee: function (emp) {
      if (!guard("employees")) return emp;
      replaceIn(cache.employees, emp);
      send("POST", "employees", "", emp);
      return emp;
    },
    /* Save and (optionally) create/replace their login. Resolves/rejects so the dialog can show errors. */
    saveEmployeeAsync: function (emp, password) {
      if (!Store.can("employees", "edit")) return Promise.reject(new Error("You have view-only access here."));
      return api("POST", "employees", "", emp).then(function (res) {
        replaceIn(cache.employees, empFromRow(res.employee));
        if (me && me.id === emp.id) me = empFromRow(res.employee);
        if (password) {
          return api("POST", "identity-users", "", { email: emp.email, password: password })
            .then(function (r) { return { loginCreated: !!r.created, loginUpdated: !r.created }; });
        }
        return {};
      });
    },
    deleteEmployee: function (id) {
      var emp = this.getEmployee(id);
      if (!emp) return { ok: false, reason: "not-found" };
      var holding = cache.items.some(function (it) { return it.holder === id; });
      if (holding) return { ok: false, reason: "holding-items", employee: emp };
      if (me && me.id === id) return { ok: false, reason: "self", employee: emp };
      if (!guard("employees")) return { ok: false, reason: "read-only" };
      cache.employees = cache.employees.filter(function (e) { return e.id !== id; });
      cache.callEntries = cache.callEntries.filter(function (c) { return c.empId !== id; });
      this.addLog({ type: "delete-employee", itemName: "", empName: emp.name, empId: emp.id });
      send("DELETE", "employees", "id=" + encodeURIComponent(id));
      return { ok: true };
    },
    nextEmployeeId: function () {
      var max = 999;
      cache.employees.forEach(function (e) {
        var n = parseInt(String(e.id).replace(/\D/g, ""), 10);
        if (!isNaN(n) && n > max) max = n;
      });
      return "ID-" + (max + 1);
    },

    /* ----- role categories ----- */
    getRoles: function () { return cache.roles; },
    getRole: function (id) {
      return cache.roles.find(function (r) { return r.id === id; }) || null;
    },
    saveRole: function (role) {
      if (!guard("settings")) return role;
      if (!role.id) role.id = uid("role");
      replaceIn(cache.roles, role);
      send("POST", "settings", "resource=roles", { id: role.id, name: role.name });
      return role;
    },
    deleteRole: function (id) {
      var role = this.getRole(id);
      if (!role) return { ok: false, reason: "not-found" };
      if (cache.employees.some(function (e) { return e.roleId === id; })) {
        return { ok: false, reason: "in-use", role: role };
      }
      if (!guard("settings")) return { ok: false, reason: "read-only" };
      cache.roles = cache.roles.filter(function (r) { return r.id !== id; });
      cache.items.forEach(function (it) {
        if (Array.isArray(it.restrictedTo) && it.restrictedTo.indexOf(id) > -1) {
          it.restrictedTo = it.restrictedTo.filter(function (r) { return r !== id; });
        }
      });
      send("DELETE", "settings", "resource=roles&id=" + encodeURIComponent(id));
      return { ok: true };
    },

    /* ----- show roles ----- */
    getShowRoles: function () { return cache.showRoles; },
    getShowRole: function (id) {
      return cache.showRoles.find(function (r) { return r.id === id; }) || null;
    },
    saveShowRole: function (role) {
      if (!guard("settings")) return role;
      if (!role.id) role.id = uid("showrole");
      replaceIn(cache.showRoles, role);
      send("POST", "settings", "resource=showRoles", { id: role.id, name: role.name });
      return role;
    },
    deleteShowRole: function (id) {
      var role = this.getShowRole(id);
      if (!role) return { ok: false, reason: "not-found" };
      if (cache.callEntries.some(function (c) { return c.showRoleId === id; })) {
        return { ok: false, reason: "in-use", role: role };
      }
      if (!guard("settings")) return { ok: false, reason: "read-only" };
      cache.showRoles = cache.showRoles.filter(function (r) { return r.id !== id; });
      send("DELETE", "settings", "resource=showRoles&id=" + encodeURIComponent(id));
      return { ok: true };
    },

    /* ----- shows ----- */
    getShows: function () { return cache.shows; },
    getShow: function (id) {
      return cache.shows.find(function (s) { return s.id === id; }) || null;
    },
    saveShow: function (show) {
      if (!guard("settings")) return show;
      if (!show.id) show.id = uid("show");
      replaceIn(cache.shows, show);
      send("POST", "settings", "resource=shows", { id: show.id, name: show.name });
      return show;
    },
    deleteShow: function (id) {
      if (!guard("settings")) return { ok: false, reason: "read-only" };
      cache.shows = cache.shows.filter(function (s) { return s.id !== id; });
      cache.callEntries = cache.callEntries.filter(function (c) { return c.showId !== id; });
      send("DELETE", "settings", "resource=shows&id=" + encodeURIComponent(id));
      return { ok: true };
    },
    callEntryCount: function (showId) {
      return cache.callEntries.filter(function (c) { return c.showId === showId; }).length;
    },

    /* ----- call list ----- */
    getCallList: function () { return cache.callEntries; },
    getCallListForShow: function (showId) {
      return cache.callEntries.filter(function (c) { return c.showId === showId; });
    },
    saveCallEntry: function (entry) {
      if (!guard("callList")) return entry;
      var isNew = !entry.id || !cache.callEntries.some(function (c) { return c.id === entry.id; });
      if (!entry.id) entry.id = uid("call");
      replaceIn(cache.callEntries, entry);
      if (isNew) {
        send("POST", "call-list", "", { id: entry.id, showId: entry.showId, empId: entry.empId, showRoleId: entry.showRoleId, comm: !!entry.comm });
      } else {
        send("PUT", "call-list", "", { id: entry.id, comm: !!entry.comm, showRoleId: entry.showRoleId });
      }
      return entry;
    },
    deleteCallEntry: function (id) {
      if (!guard("callList")) return;
      cache.callEntries = cache.callEntries.filter(function (c) { return c.id !== id; });
      send("DELETE", "call-list", "id=" + encodeURIComponent(id));
    },

    /* ----- activity log (the server writes the real log; this keeps the open page current) ----- */
    getLog: function () {
      return cache.log.slice().sort(function (a, b) { return b.ts - a.ts; });
    },
    addLog: function (entry) {
      entry.ts = Date.now();
      cache.log.push(entry);
      return entry;
    },

    /* ----- transactions ----- */
    checkOut: function (itemId, empId) {
      var item = this.getItem(itemId);
      var emp = this.getEmployee(empId);
      if (!item) return { ok: false, reason: "item-not-found" };
      if (!emp) return { ok: false, reason: "employee-not-found" };
      if (item.status === "out") return { ok: false, reason: "already-out", item: item };
      if (item.status === "maint" || item.status === "fault") return { ok: false, reason: "unavailable", item: item };
      if (Array.isArray(item.restrictedTo) && item.restrictedTo.length &&
          item.restrictedTo.indexOf(emp.roleId) === -1) {
        return { ok: false, reason: "restricted", item: item, employee: emp };
      }
      if (!guard("inventory")) return { ok: false, reason: "read-only" };
      item.status = "out";
      item.holder = emp.id;
      item.due = null;
      this.addLog({ type: "out", itemId: item.id, itemName: item.name, empId: emp.id, empName: emp.name });
      send("POST", "items", "action=checkout", { itemId: item.id, empId: emp.id });
      return { ok: true, item: item, employee: emp };
    },
    checkIn: function (itemId) {
      var item = this.getItem(itemId);
      if (!item) return { ok: false, reason: "item-not-found" };
      if (item.status !== "out") return { ok: false, reason: "not-out", item: item };
      if (!guard("inventory")) return { ok: false, reason: "read-only" };
      var emp = this.getEmployee(item.holder);
      var prev = emp ? emp.name : "Unknown";
      item.status = "ok";
      item.holder = null;
      item.due = null;
      this.addLog({ type: "in", itemId: item.id, itemName: item.name, empId: emp ? emp.id : null, empName: prev });
      send("POST", "items", "action=checkin", { itemId: item.id });
      return { ok: true, item: item, previousHolderName: prev };
    },
    setItemStatus: function (itemId, status, note) {
      var item = this.getItem(itemId);
      if (!item) return { ok: false, reason: "item-not-found" };
      if (item.status === "out") return { ok: false, reason: "checked-out", item: item };
      if (!guard("inventory")) return { ok: false, reason: "read-only" };
      var labels = { ok: "Cleared — back in service", maint: "Marked in maintenance", fault: "Flagged as damaged" };
      var prev = item.status;
      item.status = status;
      item.holder = null;
      if (prev !== status) {
        this.addLog({
          type: "status", itemId: item.id, itemName: item.name, empName: "",
          note: (labels[status] || "Status updated") + (note ? " — " + note : "")
        });
      }
      send("POST", "items", "action=status", { itemId: item.id, status: status, note: note || "" });
      return { ok: true, item: item };
    },
    addMaintenanceNote: function (itemId, note) {
      var item = this.getItem(itemId);
      if (!item) return { ok: false, reason: "item-not-found" };
      note = String(note || "").trim();
      if (!note) return { ok: false, reason: "empty" };
      if (!guard("inventory")) return { ok: false, reason: "read-only" };
      this.addLog({ type: "note", itemId: item.id, itemName: item.name, note: note, empName: "" });
      send("POST", "items", "action=note", { itemId: item.id, note: note });
      return { ok: true };
    },
    itemHistory: function (itemId) {
      return this.getLog().filter(function (e) { return e.itemId === itemId; });
    },

    /* ----- consumable stock ----- */
    stockLevel: function (item) {
      if (!item || item.trackingMode !== "consumable") return "n/a";
      var qty = item.quantity || 0;
      var min = item.minQuantity || 0;
      if (qty <= 0) return "out";
      if (min > 0 && qty <= min) return "low";
      return "ok";
    },
    lowStockItems: function () {
      var self = this;
      return cache.items.filter(function (it) {
        return it.trackingMode === "consumable" && self.stockLevel(it) !== "ok";
      });
    },
    adjustQuantity: function (itemId, delta, note) {
      var item = this.getItem(itemId);
      if (!item) return { ok: false, reason: "item-not-found" };
      if (item.trackingMode !== "consumable") return { ok: false, reason: "not-consumable" };
      var next = (item.quantity || 0) + delta;
      if (next < 0) return { ok: false, reason: "insufficient-stock", item: item };
      if (!guard("inventory")) return { ok: false, reason: "read-only" };
      item.quantity = next;
      this.addLog({
        type: delta >= 0 ? "restock" : "use", itemId: item.id, itemName: item.name,
        note: (delta >= 0 ? "+" : "") + delta + " " + (item.unitLabel || "units") +
          (note ? " — " + note : "") + " (now " + next + " on hand)",
        empName: ""
      });
      send("POST", "items", "action=quantity", { itemId: item.id, delta: delta, note: note || "" });
      return { ok: true, item: item };
    },
    useConsumable: function (itemId, empId, qty) {
      qty = qty || 1;
      var item = this.getItem(itemId);
      if (!item) return { ok: false, reason: "item-not-found" };
      if (item.trackingMode !== "consumable") return { ok: false, reason: "not-consumable" };
      var emp = empId ? this.getEmployee(empId) : null;
      if (Array.isArray(item.restrictedTo) && item.restrictedTo.length) {
        if (!(emp && item.restrictedTo.indexOf(emp.roleId) > -1)) {
          return { ok: false, reason: "restricted", item: item, employee: emp };
        }
      }
      if ((item.quantity || 0) < qty) return { ok: false, reason: "insufficient-stock", item: item };
      if (!guard("inventory")) return { ok: false, reason: "read-only" };
      item.quantity = item.quantity - qty;
      this.addLog({
        type: "use", itemId: item.id, itemName: item.name,
        note: "-" + qty + " " + (item.unitLabel || "units") + " (now " + item.quantity + " on hand)",
        empId: emp ? emp.id : null, empName: emp ? emp.name : ""
      });
      send("POST", "items", "action=quantity", { itemId: item.id, delta: -qty, empId: emp ? emp.id : null });
      return { ok: true, item: item };
    },

    counts: function () {
      var items = cache.items.filter(function (it) { return it.trackingMode !== "consumable"; });
      var out = { ok: 0, out: 0, maint: 0, fault: 0 };
      items.forEach(function (it) { if (out[it.status] !== undefined) out[it.status]++; });
      return out;
    },

    /* ----- one-time import of the old browser-only data (used by the Settings page) ----- */
    legacyLocalData: function () {
      function read(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
      var d = {
        items: read("hl_items") || [], employees: read("hl_employees") || [], roles: read("hl_roles") || [],
        locations: read("hl_locations") || [], showRoles: read("hl_show_roles") || [], shows: read("hl_shows") || [],
        callEntries: read("hl_call_entries") || []
      };
      var total = d.items.length + d.employees.length + d.showRoles.length + d.shows.length + d.callEntries.length;
      return total ? d : null;
    },
    importLegacy: function (d) {
      return api("POST", "import-legacy", "", d);
    },

    /* Used by the test harness / diagnostics only */
    _sortHelpers: { byName: byName }
  };

  global.Store = Store;
})(window);
