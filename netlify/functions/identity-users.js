/**
 * /api/identity-users   (requires perm_employees = edit)
 *
 * POST { email, password }  -> create a login (already confirmed — no email step),
 *                              or, if that email already has a login, set its password.
 * This is how the Employees page "adds someone's username and password".
 * Passwords are handed straight to Netlify Identity, which hashes them; this
 * app never stores or logs them.
 */

const { getSupabaseClient, requirePermission, venueDb, jsonResponse, identityAdmin, findIdentityUserByEmail } = require("./_shared/auth");

exports.handler = async function (event, context) {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed." });

  let supabase;
  try {
    supabase = getSupabaseClient();
  } catch (e) {
    return jsonResponse(500, { error: e.message });
  }

  const { employee: me, error } = await requirePermission(context, supabase, "perm_employees", "edit");
  if (error) return jsonResponse(error.statusCode, { error: error.message });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return jsonResponse(400, { error: "Invalid JSON body." });
  }
  const email = String(body.email || "").toLowerCase().trim();
  const password = String(body.password || "");
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return jsonResponse(400, { error: "A valid email is required." });
  if (password.length < 8) return jsonResponse(400, { error: "Password must be at least 8 characters." });

  // Only allow logins for emails on THIS venue's roster. (If this looked at every venue,
  // an admin here could set the password of someone on another venue's roster.)
  const db = venueDb(supabase, me.venue_id);
  const { data: emp } = await db.from("employees").select("id").eq("email", email).maybeSingle();
  if (!emp) return jsonResponse(404, { error: "Save the employee with this email first." });

  try {
    const existing = await findIdentityUserByEmail(context, email);
    if (existing) {
      await identityAdmin(context, "PUT", "/admin/users/" + existing.id, { password: password, confirm: true });
      return jsonResponse(200, { ok: true, created: false });
    }
    await identityAdmin(context, "POST", "/admin/users", { email: email, password: password, confirm: true });
    return jsonResponse(200, { ok: true, created: true });
  } catch (e) {
    return jsonResponse(e.status && e.status < 500 ? e.status : 502, { error: e.message });
  }
};
