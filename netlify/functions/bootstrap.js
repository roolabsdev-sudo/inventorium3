/**
 * /api/bootstrap  (GET)
 *
 * One call that returns everything the signed-in person is allowed to see, so
 * pages load fast and the browser never needs to know the permission rules:
 *
 *   me          – the caller's employee row (including their permission levels)
 *   items, log  – only if Inventory access >= view
 *   callList    – only if Call List access >= view
 *   employees   – full rows only for Employees:edit callers; otherwise a roster
 *                 directory (id, name, role, active, photo) if they hold ANY page
 *                 permission — pages need names for check-outs and call lists
 *   roles, locations, showRoles, shows – small reference lists (any logged-in user)
 */

const { getSupabaseClient, getCallerEmployee, hasPermission, venueDb, getVenue, jsonResponse } = require("./_shared/auth");

exports.handler = async function (event, context) {
  if (event.httpMethod !== "GET") return jsonResponse(405, { error: "Method not allowed." });

  let supabase;
  try {
    supabase = getSupabaseClient();
  } catch (e) {
    return jsonResponse(500, { error: e.message });
  }

  const { employee: me, error } = await getCallerEmployee(context, supabase);
  if (error) return jsonResponse(error.statusCode, { error: error.message });

  const db = venueDb(supabase, me.venue_id);

  const canInv = hasPermission(me, "perm_inventory", "view");
  const canCall = hasPermission(me, "perm_call_list", "view");
  const canEmp = hasPermission(me, "perm_employees", "view");
  const canEmpEdit = hasPermission(me, "perm_employees", "edit");
  const canSet = hasPermission(me, "perm_settings", "view");
  const anyAccess = canInv || canCall || canEmp || canSet;

  const out = { me: me, branding: null, items: [], log: [], callList: [], employees: [], roles: [], locations: [], showRoles: [], shows: [] };
  const venue = await getVenue(supabase, me.venue_id);
  if (venue) out.branding = { appName: venue.name, appSubtitle: venue.subtitle || "", logo: venue.logo || null };
  if (!anyAccess) return jsonResponse(200, out);

  const jobs = [];
  function load(key, query) {
    jobs.push(query.then(function (r) {
      if (r.error) throw new Error(key + ": " + r.error.message);
      out[key] = r.data || [];
    }));
  }

  load("roles", db.from("roles").select("*").order("name"));
  load("locations", db.from("locations").select("*").order("name"));
  load("showRoles", db.from("show_roles").select("*").order("name"));
  load("shows", db.from("shows").select("*").order("name"));
  load("employees", db.from("employees").select(canEmpEdit
    ? "*"
    : "id,name,role_id,active,photo").order("name"));
  if (canInv) {
    load("items", db.from("items").select("*").order("name"));
    load("log", db.from("activity_log").select("*").order("ts", { ascending: false }).limit(500));
  }
  if (canCall) load("callList", db.from("call_list").select("*"));

  try {
    await Promise.all(jobs);
  } catch (e) {
    return jsonResponse(500, { error: e.message });
  }
  return jsonResponse(200, out);
};
