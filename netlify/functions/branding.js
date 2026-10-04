/**
 * /api/branding
 *
 * Branding now lives on the caller's venue row (venues.name / subtitle / logo).
 *
 * GET            -> { appName, appSubtitle, logo }   the generic placeholder for everyone: the
 *                   sign-in page doesn't know the venue yet. Signed-in pages get their venue's
 *                   branding from /api/bootstrap instead.
 * POST/PUT       -> save all three fields            (Settings: edit)
 * DELETE         -> reset to the placeholders        (Settings: edit)
 */
const { getSupabaseClient, requirePermission, jsonResponse } = require("./_shared/auth");

const DEFAULTS = { appName: "Inventorium", appSubtitle: "", logo: null };
const LOGO_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;


exports.handler = async function (event, context) {
  let supabase;
  try { supabase = getSupabaseClient(); } catch (e) {
    return event.httpMethod === "GET" ? jsonResponse(200, DEFAULTS) : jsonResponse(500, { error: e.message });
  }

  if (event.httpMethod === "GET") {
    const res = jsonResponse(200, DEFAULTS);
    res.headers["Cache-Control"] = "no-store";
    return res;
  }

  if (["POST", "PUT", "DELETE"].indexOf(event.httpMethod) === -1) return jsonResponse(405, { error: "Method not allowed." });

  const { employee: me, error: authErr } = await requirePermission(context, supabase, "perm_settings", "edit");
  if (authErr) return jsonResponse(authErr.statusCode, { error: authErr.message });

  let next = DEFAULTS;
  if (event.httpMethod !== "DELETE") {
    let b;
    try { b = JSON.parse(event.body || "{}"); } catch (e) { return jsonResponse(400, { error: "Bad request." }); }
    const name = String(b.appName || "").trim();
    const sub = String(b.appSubtitle || "").trim();
    const logo = b.logo == null || b.logo === "" ? null : String(b.logo);
    if (!name) return jsonResponse(400, { error: "Enter a name." });
    if (name.length > 60) return jsonResponse(400, { error: "Name must be 60 characters or fewer." });
    if (sub.length > 40) return jsonResponse(400, { error: "Subtitle must be 40 characters or fewer." });
    if (logo && (logo.length > 400000 || !LOGO_RE.test(logo))) return jsonResponse(400, { error: "Logo must be a PNG, JPEG or WebP image under about 300 KB." });
    next = { appName: name, appSubtitle: sub, logo: logo };
  }

  const { error } = await supabase.from("venues")
    .update({ name: next.appName, subtitle: next.appSubtitle, logo: next.logo })
    .eq("id", me.venue_id);
  if (error) return jsonResponse(500, { error: "Couldn't save branding." });
  return jsonResponse(200, next);
};
