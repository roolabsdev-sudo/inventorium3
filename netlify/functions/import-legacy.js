/**
 * /api/import-legacy  (POST)  — one-time move of the old browser-only data to the cloud.
 *
 * Body: { items, employees, roles, locations, showRoles, shows, callEntries } in the
 * OLD localStorage shapes. Requires edit on Inventory, Employees, Call List and Settings
 * (i.e. an admin). Safe to re-run: existing rows with the same id are left alone.
 * Imported employees get NO login and NO permissions until you set them on the Employees page.
 */

const { getSupabaseClient, getCallerEmployee, hasPermission, venueDb, jsonResponse } = require("./_shared/auth");

function uid(prefix) {
  return prefix + "-" + Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 5);
}

async function insertIgnore(db, table, rows, onConflict) {
  if (!rows.length) return 0;
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await db.from(table).upsert(rows.slice(i, i + 200), { onConflict: onConflict || "id", ignoreDuplicates: true });
    if (error) throw new Error(table + ": " + error.message);
  }
  return rows.length;
}

exports.handler = async function (event, context) {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed." });
  let supabase;
  try { supabase = getSupabaseClient(); } catch (e) { return jsonResponse(500, { error: e.message }); }

  const { employee, error } = await getCallerEmployee(context, supabase);
  if (error) return jsonResponse(error.statusCode, { error: error.message });
  const ok = ["perm_inventory", "perm_employees", "perm_call_list", "perm_settings"].every(function (k) {
    return hasPermission(employee, k, "edit");
  });
  if (!ok) return jsonResponse(403, { error: "Importing needs edit access to every page (an admin account)." });

  const db = venueDb(supabase, employee.venue_id);

  let d;
  try { d = JSON.parse(event.body || "{}"); } catch (e) { return jsonResponse(400, { error: "Invalid JSON body." }); }
  const arr = function (v) { return Array.isArray(v) ? v : []; };

  try {
    const roles = arr(d.roles).filter(function (r) { return r && r.id && r.name; }).map(function (r) { return { id: r.id, name: r.name }; });
    const locations = arr(d.locations).filter(Boolean).map(function (n) {
      const name = typeof n === "string" ? n : n.name;
      return { id: (n && n.id) || uid("loc"), name: name };
    });
    const showRoles = arr(d.showRoles).filter(function (r) { return r && r.id && r.name; }).map(function (r) { return { id: r.id, name: r.name }; });
    const shows = arr(d.shows).filter(function (r) { return r && r.id && r.name; }).map(function (r) { return { id: r.id, name: r.name }; });

    const empRows = arr(d.employees).filter(function (e) { return e && e.id && e.name; }).map(function (e) {
      return {
        id: e.id, name: e.name, role_id: e.roleId || null, active: e.active !== false, photo: e.photo || null,
        perm_inventory: "none", perm_call_list: "none", perm_employees: "none", perm_settings: "none"
      };
    });
    const empIds = {};
    empRows.forEach(function (e) { empIds[e.id] = true; });
    const roleIds = {};
    roles.forEach(function (r) { roleIds[r.id] = true; });

    // Roles referenced by employees but missing from the list would break the import; drop dangling refs.
    const itemRows = arr(d.items).filter(function (i) { return i && i.id && i.name; }).map(function (i) {
      const consumable = i.trackingMode === "consumable";
      return {
        id: i.id, group_id: i.groupId || null, name: i.name, category: i.category || null, location: i.location || null,
        status: i.status || "ok", holder: i.holder && empIds[i.holder] ? i.holder : null,
        aliases: i.aliases || null, notes: i.notes || null,
        restricted_to: arr(i.restrictedTo), photo: i.photo || null, serial: i.serial || null,
        condition: i.condition || null, purchase_date: i.purchaseDate || null,
        purchase_cost: i.purchaseCost == null || i.purchaseCost === "" ? null : Number(i.purchaseCost),
        manual_url: i.manualUrl || null,
        tracking_mode: consumable ? "consumable" : null,
        quantity: consumable ? Number(i.quantity) || 0 : null,
        unit_label: consumable ? (i.unitLabel || null) : null,
        min_quantity: consumable ? Number(i.minQuantity) || 0 : null
      };
    });
    const showIds = {}; shows.forEach(function (s) { showIds[s.id] = true; });
    const srIds = {}; showRoles.forEach(function (s) { srIds[s.id] = true; });
    const callRows = arr(d.callEntries).filter(function (c) { return c && c.showId && c.empId && showIds[c.showId] && empIds[c.empId]; }).map(function (c) {
      return { id: c.id || uid("call"), show_id: c.showId, emp_id: c.empId, show_role_id: srIds[c.showRoleId] ? c.showRoleId : null, comm: !!c.comm };
    });

    // Locations are unique by name; skip ones that already exist.
    const { data: haveLocs } = await db.from("locations").select("name");
    const haveNames = {}; (haveLocs || []).forEach(function (l) { haveNames[l.name.toLowerCase()] = true; });
    const newLocs = locations.filter(function (l) { return l.name && !haveNames[l.name.toLowerCase()]; });

    const counts = {};
    counts.roles = await insertIgnore(db, "roles", roles);
    counts.locations = await insertIgnore(db, "locations", newLocs);
    counts.employees = await insertIgnore(db, "employees", empRows);
    counts.showRoles = await insertIgnore(db, "show_roles", showRoles);
    counts.shows = await insertIgnore(db, "shows", shows);
    counts.items = await insertIgnore(db, "items", itemRows);
    counts.callEntries = await insertIgnore(db, "call_list", callRows, "show_id,emp_id");
    return jsonResponse(200, { ok: true, counts: counts });
  } catch (e) {
    return jsonResponse(500, { error: e.message });
  }
};
