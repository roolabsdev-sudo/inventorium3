/**
 * /api/identity-users   (requires perm_employees = edit)
 *
 * POST { email, password }  -> create a login (already confirmed — no email step),
 *                              or reset the password of a login THIS venue created.
 * This is how the Employees page "adds someone's username and password".
 *
 * Security: anyone can now sign up and create a venue, so "set a password for any email on my
 * roster" would let a stranger take over somebody else's login. Logins this function creates are
 * stamped with app_metadata.provisioned_by = <venue id>, and a password can only be reset on a
 * login carrying THIS venue's stamp. A login the person made for themselves (no stamp) can only
 * be changed by them ("Forgot password?"). Logins that existed before multi-venue (also no stamp)
 * all belong to the original venue, so only that venue (the earliest-created one) may reset them.
 * Passwords are handed straight to Netlify Identity, which hashes them; this
 * app never stores or logs them.
 */

const { getSupabaseClient, requirePermission, venueDb, jsonResponse, identityAdmin, findIdentityUserByEmail } = require("./_shared/auth");

/** The original (earliest-created) venue: owner of every login made before multi-venue. */
async function isOriginalVenue(supabase, venueId) {
  const { data } = await supabase.from("venues").select("id").is("deleted_at", null).order("created_at").limit(1);
  return !!(data && data[0] && data[0].id === venueId);
}

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
      const stamp = existing.app_metadata && existing.app_metadata.provisioned_by;
      const mine = stamp ? stamp === me.venue_id : await isOriginalVenue(supabase, me.venue_id);
      if (!mine) {
        return jsonResponse(409, { error: email + " already has a login of their own. They can sign in with it, or choose \"Forgot password?\" to reset it themselves." });
      }
      await identityAdmin(context, "PUT", "/admin/users/" + existing.id, { password: password, confirm: true });
      return jsonResponse(200, { ok: true, created: false });
    }
    await identityAdmin(context, "POST", "/admin/users", {
      email: email, password: password, confirm: true,
      app_metadata: { provisioned_by: me.venue_id }
    });
    return jsonResponse(200, { ok: true, created: true });
  } catch (e) {
    return jsonResponse(e.status && e.status < 500 ? e.status : 502, { error: e.message });
  }
};
