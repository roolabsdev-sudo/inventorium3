/**
 * /api/call-list
 *
 * GET                                  -> all entries                 (perm_call_list >= view)
 * POST { id, showId, empId, showRoleId, comm } -> add an entry         (edit)
 * PUT  { id, showRoleId, comm }        -> update an entry              (edit)
 * DELETE ?id=                          -> remove an entry              (edit)
 */

const { getSupabaseClient, requirePermission, venueDb, jsonResponse } = require("./_shared/auth");

function uid(prefix) {
  return prefix + "-" + Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 5);
}

exports.handler = async function (event, context) {
  let supabase;
  try { supabase = getSupabaseClient(); } catch (e) { return jsonResponse(500, { error: e.message }); }

  const m = event.httpMethod;
  const needed = m === "GET" ? "view" : "edit";
  const { employee: me, error } = await requirePermission(context, supabase, "perm_call_list", needed);
  if (error) return jsonResponse(error.statusCode, { error: error.message });
  const db = venueDb(supabase, me.venue_id);

  if (m === "GET") {
    const { data, error: dbError } = await db.from("call_list").select("*");
    if (dbError) return jsonResponse(500, { error: dbError.message });
    return jsonResponse(200, { callList: data });
  }

  if (m === "DELETE") {
    const id = (event.queryStringParameters || {}).id;
    if (!id) return jsonResponse(400, { error: "id query parameter is required." });
    const { error: dbError } = await db.from("call_list").delete().eq("id", id);
    if (dbError) return jsonResponse(500, { error: dbError.message });
    return jsonResponse(200, { ok: true });
  }

  if (m !== "POST" && m !== "PUT") return jsonResponse(405, { error: "Method not allowed." });

  let b;
  try { b = JSON.parse(event.body || "{}"); } catch (e) { return jsonResponse(400, { error: "Invalid JSON body." }); }

  if (m === "PUT") {
    if (!b.id) return jsonResponse(400, { error: "id is required." });
    const { data, error: dbError } = await db.from("call_list")
      .update({ comm: !!b.comm, show_role_id: b.showRoleId || null }).eq("id", b.id).select().single();
    if (dbError) {
      if (dbError.code === "PGRST116") return jsonResponse(404, { error: "Entry not found." });
      if (dbError.code === "23503") return jsonResponse(400, { error: "That show role isn't in this venue." });
      return jsonResponse(500, { error: dbError.message });
    }
    return jsonResponse(200, { entry: data });
  }

  if (!b.showId || !b.empId) return jsonResponse(400, { error: "showId and empId are required." });
  const row = { id: b.id || uid("call"), show_id: b.showId, emp_id: b.empId, show_role_id: b.showRoleId || null, comm: !!b.comm };
  const { data, error: dbError } = await db.from("call_list").insert(row).select().single();
  if (dbError) {
    if (dbError.code === "23505") return jsonResponse(409, { error: "That person is already on this show's call list." });
    if (dbError.code === "23503") return jsonResponse(400, { error: "That show, person or show role isn't in this venue." });
    return jsonResponse(500, { error: dbError.message });
  }
  return jsonResponse(200, { entry: data });
};
