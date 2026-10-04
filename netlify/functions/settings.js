/**
 * /api/settings?resource=roles|locations|showRoles|shows   (requires perm_settings = edit)
 *
 * POST   { id, name }  -> create or rename. Renaming a location also renames it on every item.
 * DELETE ?id=          -> delete. Blocked while still in use (a role someone has, a location
 *                         items are in, a show role used on a call list). Deleting a role
 *                         removes it from items' restriction lists; deleting a show removes
 *                         its call-list entries.
 */

const { getSupabaseClient, requirePermission, jsonResponse } = require("./_shared/auth");

const TABLES = { roles: "roles", locations: "locations", showRoles: "show_roles", shows: "shows" };

exports.handler = async function (event, context) {
  let supabase;
  try { supabase = getSupabaseClient(); } catch (e) { return jsonResponse(500, { error: e.message }); }

  const { error } = await requirePermission(context, supabase, "perm_settings", "edit");
  if (error) return jsonResponse(error.statusCode, { error: error.message });

  const qs = event.queryStringParameters || {};
  const resource = qs.resource;
  const table = TABLES[resource];
  if (!table) return jsonResponse(400, { error: "Unknown resource." });

  if (event.httpMethod === "DELETE") {
    const id = qs.id;
    if (!id) return jsonResponse(400, { error: "id query parameter is required." });

    if (resource === "roles") {
      const { count } = await supabase.from("employees").select("id", { count: "exact", head: true }).eq("role_id", id);
      if (count > 0) return jsonResponse(409, { error: "Employees still have this role." });
      const { data: items } = await supabase.from("items").select("id,restricted_to");
      for (const it of items || []) {
        const list = Array.isArray(it.restricted_to) ? it.restricted_to : [];
        if (list.indexOf(id) !== -1) {
          await supabase.from("items").update({ restricted_to: list.filter(function (r) { return r !== id; }) }).eq("id", it.id);
        }
      }
    } else if (resource === "showRoles") {
      const { count } = await supabase.from("call_list").select("id", { count: "exact", head: true }).eq("show_role_id", id);
      if (count > 0) return jsonResponse(409, { error: "This show role is still used on a call list." });
    } else if (resource === "locations") {
      const { data: loc } = await supabase.from("locations").select("name").eq("id", id).maybeSingle();
      if (loc) {
        const { count } = await supabase.from("items").select("id", { count: "exact", head: true }).eq("location", loc.name);
        if (count > 0) return jsonResponse(409, { error: "Items are still stored in this location." });
      }
    }
    const { error: dbError } = await supabase.from(table).delete().eq("id", id);
    if (dbError) return jsonResponse(500, { error: dbError.message });
    return jsonResponse(200, { ok: true });
  }

  if (event.httpMethod !== "POST" && event.httpMethod !== "PUT") return jsonResponse(405, { error: "Method not allowed." });

  let b;
  try { b = JSON.parse(event.body || "{}"); } catch (e) { return jsonResponse(400, { error: "Invalid JSON body." }); }
  const name = String(b.name || "").trim();
  if (!b.id || !name) return jsonResponse(400, { error: "An id and a name are required." });

  let oldName = null;
  if (resource === "locations") {
    const { data: prev } = await supabase.from("locations").select("name").eq("id", b.id).maybeSingle();
    oldName = prev ? prev.name : null;
  }

  const { data, error: dbError } = await supabase.from(table).upsert({ id: b.id, name: name }, { onConflict: "id" }).select().single();
  if (dbError) {
    if (dbError.code === "23505") return jsonResponse(409, { error: "That name is already in use." });
    return jsonResponse(500, { error: dbError.message });
  }
  if (oldName && oldName !== name) {
    await supabase.from("items").update({ location: name }).eq("location", oldName);
  }
  return jsonResponse(200, { row: data });
};
