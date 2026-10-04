/**
 * /api/employees   (requires perm_employees = edit)
 *
 * POST/PUT { id, name, roleId, active, photo, email, permInventory, permCallList,
 *            permEmployees, permSettings }  -> create or update. Returns { employee: row }.
 * DELETE ?id=                               -> delete (blocked while they hold items,
 *                                              and you can't delete yourself).
 * Logins (passwords) are handled separately by /api/identity-users.
 */

const { getSupabaseClient, requirePermission, venueDb, emailTaken, jsonResponse } = require("./_shared/auth");

function uid(prefix) {
  return prefix + "-" + Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 5);
}
function level(v) { return v === "edit" || v === "view" ? v : "none"; }

exports.handler = async function (event, context) {
  let supabase;
  try { supabase = getSupabaseClient(); } catch (e) { return jsonResponse(500, { error: e.message }); }

  const { employee: me, error } = await requirePermission(context, supabase, "perm_employees", "edit");
  if (error) return jsonResponse(error.statusCode, { error: error.message });

  const db = venueDb(supabase, me.venue_id);
  const qs = event.queryStringParameters || {};

  if (event.httpMethod === "DELETE") {
    if (!qs.id) return jsonResponse(400, { error: "id query parameter is required." });
    if (qs.id === me.id) return jsonResponse(409, { error: "You can't delete your own account." });
    const { data: emp } = await db.from("employees").select("*").eq("id", qs.id).maybeSingle();
    if (!emp) return jsonResponse(404, { error: "Employee not found." });
    const { count } = await db.from("items").select("id", { count: "exact", head: true }).eq("holder", qs.id);
    if (count > 0) return jsonResponse(409, { error: emp.name + " still has items checked out." });
    const { error: dbError } = await db.from("employees").delete().eq("id", qs.id);
    if (dbError) return jsonResponse(500, { error: dbError.message });
    await db.from("activity_log").insert({ id: uid("log"), ts: new Date().toISOString(), type: "delete-employee", emp_id: emp.id, emp_name: emp.name });
    return jsonResponse(200, { ok: true });
  }

  if (event.httpMethod !== "POST" && event.httpMethod !== "PUT") return jsonResponse(405, { error: "Method not allowed." });

  let b;
  try { b = JSON.parse(event.body || "{}"); } catch (e) { return jsonResponse(400, { error: "Invalid JSON body." }); }
  const name = String(b.name || "").trim();
  if (!b.id || !name) return jsonResponse(400, { error: "An id and a name are required." });
  const email = String(b.email || "").toLowerCase().trim();
  if (email && !/^\S+@\S+\.\S+$/.test(email)) return jsonResponse(400, { error: "That email address doesn't look right." });

  if (email) {
    // Emails are unique across every venue (one venue per email). Only name the person if they're in THIS venue.
    const clash = await emailTaken(supabase, email, me.venue_id, b.id);
    if (clash.taken) {
      return jsonResponse(409, { error: clash.sameVenueName
        ? email + " is already used by " + clash.sameVenueName + "."
        : email + " is already on another venue's roster." });
    }
  }

  // A role must belong to this venue.
  let roleId = b.roleId || null;
  if (roleId) {
    const { data: role } = await db.from("roles").select("id").eq("id", roleId).maybeSingle();
    if (!role) roleId = null;
  }

  const { data: existing } = await db.from("employees").select("*").eq("id", b.id).maybeSingle();
  const row = {
    id: b.id, name: name, role_id: roleId, active: b.active !== false,
    photo: b.photo || null, email: email || null,
    perm_inventory: level(b.permInventory), perm_call_list: level(b.permCallList),
    perm_employees: level(b.permEmployees), perm_settings: level(b.permSettings),
    updated_at: new Date().toISOString()
  };

  // Safety net: an admin can't lock themselves out of the Employees page or deactivate themselves.
  if (b.id === me.id) {
    row.perm_employees = "edit";
    row.active = true;
  }
  if (existing && existing.email && !email && existing.email === me.email) row.email = existing.email;

  const { data, error: dbError } = await db.from("employees").upsert(row, { onConflict: "id" }).select().single();
  if (dbError) return jsonResponse(500, { error: dbError.message });
  return jsonResponse(200, { employee: data });
};
