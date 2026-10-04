/**
 * /api/join-codes   (requires perm_employees = edit)
 *
 * GET                    -> { codes: [...] } this venue's codes that haven't been turned off, newest first.
 *                           Each has { id, code, roleId, permInventory, permCallList, permEmployees,
 *                           permSettings, maxUses, uses, expiresAt, createdAt, state } where state is
 *                           "active" | "expired" | "used_up".
 * POST { roleId?, permInventory, permCallList, permEmployees, permSettings, days?, maxUses? }
 *                        -> make a code. days is 1-30 (default 7); maxUses is blank (no limit) or 1-1000.
 *                           Returns { code: {...} }.
 * DELETE ?id=            -> turn a code off. Requests already made with it stay and can still be decided.
 *
 * Everything is pinned to the caller's venue through venueDb(), so one venue can never list or
 * turn off another venue's codes.
 */
const { getSupabaseClient, requirePermission, venueDb, jsonResponse } = require("./_shared/auth");
const J = require("./_shared/joincodes");

function view(row, uses, now) {
  let state = "active";
  if (new Date(row.expires_at).getTime() <= now) state = "expired";
  else if (row.max_uses != null && uses >= row.max_uses) state = "used_up";
  return {
    id: row.id, code: J.formatCode(row.code), roleId: row.role_id || null,
    permInventory: row.perm_inventory, permCallList: row.perm_call_list,
    permEmployees: row.perm_employees, permSettings: row.perm_settings,
    maxUses: row.max_uses == null ? null : row.max_uses, uses: uses,
    expiresAt: row.expires_at, createdAt: row.created_at, state: state
  };
}

exports.handler = async function (event, context) {
  let supabase;
  try { supabase = getSupabaseClient(); } catch (e) { return jsonResponse(500, { error: e.message }); }

  const { employee: me, error } = await requirePermission(context, supabase, "perm_employees", "edit");
  if (error) return jsonResponse(error.statusCode, { error: error.message });
  const db = venueDb(supabase, me.venue_id);

  if (event.httpMethod === "GET") {
    const codes = await db.from("join_codes").select("*").is("revoked_at", null).order("created_at", { ascending: false }).limit(100);
    if (codes.error) return jsonResponse(500, { error: "Couldn't load join codes." });
    const reqs = await db.from("join_requests").select("code_id,status").in("status", ["pending", "approved"]);
    if (reqs.error) return jsonResponse(500, { error: "Couldn't load join codes." });
    const used = {};
    (reqs.data || []).forEach(function (r) { if (r.code_id != null) used[r.code_id] = (used[r.code_id] || 0) + 1; });
    const now = Date.now();
    return jsonResponse(200, { codes: (codes.data || []).map(function (c) { return view(c, used[c.id] || 0, now); }) });
  }

  if (event.httpMethod === "DELETE") {
    const id = Number((event.queryStringParameters || {}).id);
    if (!Number.isInteger(id)) return jsonResponse(400, { error: "id query parameter is required." });
    const found = await db.from("join_codes").select("id").eq("id", id).is("revoked_at", null).maybeSingle();
    if (found.error) return jsonResponse(500, { error: "Couldn't turn that code off." });
    if (!found.data) return jsonResponse(404, { error: "Code not found." });
    const done = await db.from("join_codes").update({ revoked_at: new Date().toISOString() }).eq("id", id);
    if (done.error) return jsonResponse(500, { error: "Couldn't turn that code off." });
    return jsonResponse(200, { ok: true });
  }

  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed." });

  let b;
  try { b = JSON.parse(event.body || "{}"); } catch (e) { return jsonResponse(400, { error: "Invalid JSON body." }); }

  const days = b.days == null || b.days === "" ? J.DEFAULT_DAYS : Number(b.days);
  if (!Number.isInteger(days) || days < 1 || days > J.MAX_DAYS) return jsonResponse(400, { error: "Expiry must be between 1 and " + J.MAX_DAYS + " days." });
  let maxUses = null;
  if (b.maxUses != null && b.maxUses !== "") {
    maxUses = Number(b.maxUses);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > J.MAX_USES_LIMIT) return jsonResponse(400, { error: "The use limit must be a whole number from 1 to " + J.MAX_USES_LIMIT + ", or left blank." });
  }

  let roleId = null;
  if (b.roleId) {
    const role = await db.from("roles").select("id").eq("id", String(b.roleId)).maybeSingle();
    if (role.error) return jsonResponse(500, { error: "Couldn't check that role." });
    if (!role.data) return jsonResponse(400, { error: "That role doesn't exist." });
    roleId = role.data.id;
  }

  const row = {
    role_id: roleId,
    perm_inventory: J.levelOf(b.permInventory), perm_call_list: J.levelOf(b.permCallList),
    perm_employees: J.levelOf(b.permEmployees), perm_settings: J.levelOf(b.permSettings),
    max_uses: maxUses,
    expires_at: new Date(Date.now() + days * 86400000).toISOString(),
    created_by: me.id, created_at: new Date().toISOString(), revoked_at: null
  };

  for (let attempt = 0; attempt < 5; attempt++) {
    const made = await db.from("join_codes").insert(Object.assign({ code: J.generateCode() }, row)).select().single();
    if (!made.error) return jsonResponse(200, { code: view(made.data, 0, Date.now()) });
    if (made.error.code !== "23505") return jsonResponse(500, { error: "Couldn't create the code." });
  }
  return jsonResponse(500, { error: "Couldn't create a unique code. Try again." });
};
