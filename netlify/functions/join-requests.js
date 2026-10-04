/**
 * /api/join-requests   (requires perm_employees = edit)
 *
 * GET                          -> { requests: [...] } people waiting to join THIS venue, oldest first.
 *                                 Each has { id, email, name, roleId, permInventory, permCallList,
 *                                 permEmployees, permSettings, requestedAt }.
 * POST { id, action }          -> action is "approve" or "decline".
 *   approve: adds the person to the roster with the role and access the code promised, so their
 *            next sign-in lands in this venue. Returns { ok: true, employee: { id, name } }.
 *   decline: they go back to the "Create your venue" page and may ask again.
 *
 * Every lookup goes through venueDb(), so an admin can only ever see or decide requests made to
 * their own venue. The person's email comes from their verified login when they ask to join
 * (never from the form), and is what ties the new roster row to their login.
 */
const { getSupabaseClient, requirePermission, venueDb, emailTaken, jsonResponse } = require("./_shared/auth");

async function nextEmployeeId(db) {
  const r = await db.from("employees").select("id");
  let max = 999;
  ((r.data) || []).forEach(function (e) {
    const n = parseInt(String(e.id).replace(/\D/g, ""), 10);
    if (!isNaN(n) && n > max) max = n;
  });
  return "ID-" + (max + 1);
}

exports.handler = async function (event, context) {
  let supabase;
  try { supabase = getSupabaseClient(); } catch (e) { return jsonResponse(500, { error: e.message }); }

  const { employee: me, error } = await requirePermission(context, supabase, "perm_employees", "edit");
  if (error) return jsonResponse(error.statusCode, { error: error.message });
  const db = venueDb(supabase, me.venue_id);

  if (event.httpMethod === "GET") {
    const r = await db.from("join_requests").select("*").eq("status", "pending").order("requested_at");
    if (r.error) return jsonResponse(500, { error: "Couldn't load requests." });
    return jsonResponse(200, {
      requests: (r.data || []).map(function (q) {
        return {
          id: q.id, email: q.email, name: q.name || "", roleId: q.role_id || null,
          permInventory: q.perm_inventory, permCallList: q.perm_call_list,
          permEmployees: q.perm_employees, permSettings: q.perm_settings, requestedAt: q.requested_at
        };
      })
    });
  }

  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed." });

  let b;
  try { b = JSON.parse(event.body || "{}"); } catch (e) { return jsonResponse(400, { error: "Invalid JSON body." }); }
  const id = Number(b.id);
  if (!Number.isInteger(id)) return jsonResponse(400, { error: "A request id is required." });
  if (b.action !== "approve" && b.action !== "decline") return jsonResponse(400, { error: "Choose approve or decline." });

  const found = await db.from("join_requests").select("*").eq("id", id).eq("status", "pending").maybeSingle();
  if (found.error) return jsonResponse(500, { error: "Couldn't load that request." });
  const req = found.data;
  if (!req) return jsonResponse(404, { error: "That request has already been handled, or was withdrawn." });

  const decided = { decided_at: new Date().toISOString(), decided_by: me.id };

  async function close(status) {
    // Only a request that is still pending can be closed, so two admins can't both decide it.
    return db.from("join_requests").update(Object.assign({ status: status }, decided)).eq("id", id).eq("status", "pending");
  }

  if (b.action === "decline") {
    const d = await close("declined");
    if (d.error) return jsonResponse(500, { error: "Couldn't decline that request." });
    return jsonResponse(200, { ok: true });
  }

  // Approve. The role may have been deleted since the code was made.
  let roleId = null;
  if (req.role_id) {
    const role = await db.from("roles").select("id").eq("id", req.role_id).maybeSingle();
    roleId = role.data ? role.data.id : null;
  }
  const name = String(req.name || req.email.split("@")[0]).slice(0, 80);

  for (let attempt = 0; attempt < 3; attempt++) {
    const made = await db.from("employees").insert({
      id: await nextEmployeeId(db), name: name, email: req.email, role_id: roleId, active: true,
      perm_inventory: req.perm_inventory, perm_call_list: req.perm_call_list,
      perm_employees: req.perm_employees, perm_settings: req.perm_settings
    }).select().single();
    if (!made.error) {
      await close("approved");
      return jsonResponse(200, { ok: true, employee: { id: made.data.id, name: made.data.name } });
    }
    if (made.error.code !== "23505") return jsonResponse(500, { error: "Couldn't add them to the roster." });
    // A duplicate is either their email (they're on a roster now) or the id we picked (someone else was added a moment ago).
    const clash = await emailTaken(supabase, req.email, me.venue_id, null);
    if (clash.taken) {
      await close("cancelled");
      return jsonResponse(409, { error: req.email + " is already on a roster, so this request was closed." });
    }
  }
  return jsonResponse(500, { error: "Couldn't add them to the roster. Try again." });
};
