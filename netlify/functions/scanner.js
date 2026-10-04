/**
 * /api/scanner   (called by a scanner device, never by a signed-in person's pages)
 *
 * Auth is the X-Scanner-Token header. A Netlify Identity login is NOT used and is NOT accepted here;
 * likewise no other function accepts a scanner token. This function can do only this:
 *
 * GET                       -> what the scan page needs: { me, branding, items, employees (directory), roles, ... }
 *                              in the same shape as /api/bootstrap, so the page's Store works unchanged.
 * POST ?action=checkout     {itemId, empId}
 * POST ?action=checkin      {itemId}
 * POST ?action=quantity     {itemId, delta (negative), empId}   -> use up a consumable. A scanner can't restock.
 * POST ?action=signout      -> this device signs itself out for good.
 *
 * The check-out / check-in / use rules are the very same code the Inventory page uses (_shared/itemactions.js).
 * Everything is pinned to the device's venue through venueDb().
 */
const { getSupabaseClient, venueDb, jsonResponse } = require("./_shared/auth");
const { runItemAction } = require("./_shared/itemactions");
const { getScannerDevice } = require("./_shared/scanner");

const ALLOWED = ["checkout", "checkin", "quantity"];

exports.handler = async function (event) {
  let supabase;
  try { supabase = getSupabaseClient(); } catch (e) { return jsonResponse(500, { error: e.message }); }

  const { device, venue, error } = await getScannerDevice(event, supabase);
  if (error) return jsonResponse(error.statusCode, { error: error.message });
  const db = venueDb(supabase, device.venue_id);
  const qs = event.queryStringParameters || {};

  // Best effort: remember when this device was last used. Never blocks the request.
  const seen = supabase.from("scanner_devices").update({ last_seen_at: new Date().toISOString() }).eq("id", device.id);
  seen.then(function () {}, function () {});

  if (event.httpMethod === "GET") {
    // A made-up "person" for the page: full Inventory access, nothing else.
    const me = {
      id: "scanner-" + device.id, name: device.label || "Scanner", email: "", role_id: null, active: true,
      perm_inventory: "edit", perm_call_list: "none", perm_employees: "none", perm_settings: "none"
    };
    const out = {
      me: me, items: [], log: [], callList: [], employees: [], roles: [], locations: [], showRoles: [], shows: [],
      branding: { appName: venue.name, appSubtitle: venue.subtitle || "", logo: venue.logo || null }
    };
    const jobs = [
      db.from("items").select("*").order("name").then(function (r) { if (r.error) throw new Error("items"); out.items = r.data || []; }),
      db.from("employees").select("id,name,role_id,active,photo").order("name").then(function (r) { if (r.error) throw new Error("employees"); out.employees = r.data || []; }),
      db.from("roles").select("*").order("name").then(function (r) { if (r.error) throw new Error("roles"); out.roles = r.data || []; })
    ];
    try { await Promise.all(jobs); } catch (e) { return jsonResponse(500, { error: "Couldn't load the scan data." }); }
    return jsonResponse(200, out);
  }

  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed." });

  const action = qs.action;
  if (action === "signout") {
    const done = await supabase.from("scanner_devices").update({ revoked_at: new Date().toISOString() }).eq("id", device.id);
    if (done.error) return jsonResponse(500, { error: "Couldn't sign this scanner out." });
    return jsonResponse(200, { ok: true });
  }

  if (ALLOWED.indexOf(action) === -1) return jsonResponse(403, { error: "A scanner can only check items in and out." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return jsonResponse(400, { error: "Invalid JSON body." }); }

  if (action === "quantity") {
    // Scanning a consumable uses some up. Adding stock is for the Inventory page.
    const delta = Number(body.delta);
    if (!isFinite(delta) || delta >= 0) return jsonResponse(403, { error: "A scanner can only use up stock, not add it." });
    if (!body.empId) return jsonResponse(400, { error: "Scan an employee ID first." });
  }

  const out = await runItemAction(db, action, body);
  return jsonResponse(out.statusCode, out.body);
};
