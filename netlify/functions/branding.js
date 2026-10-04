/**
 * /api/branding
 *
 * GET            -> { appName, appSubtitle, logo }   (public: the sign-in page needs it)
 * POST/PUT       -> save all three fields            (Settings: edit)
 * DELETE         -> reset to the placeholders        (Settings: edit)
 */
const { getSupabaseClient, requirePermission, jsonResponse } = require("./_shared/auth");

const DEFAULTS = { appName: "Inventorium", appSubtitle: "", logo: null };
const LOGO_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

function shape(row) {
  if (!row) return DEFAULTS;
  if (row.app_name === "Your Venue" && !row.logo) return DEFAULTS; // row created by the earlier placeholder migration
  return {
    appName: row.app_name || DEFAULTS.appName,
    appSubtitle: row.app_subtitle == null ? DEFAULTS.appSubtitle : row.app_subtitle,
    logo: row.logo && LOGO_RE.test(row.logo) ? row.logo : null
  };
}

exports.handler = async function (event, context) {
  let supabase;
  try { supabase = getSupabaseClient(); } catch (e) {
    return event.httpMethod === "GET" ? jsonResponse(200, DEFAULTS) : jsonResponse(500, { error: e.message });
  }

  if (event.httpMethod === "GET") {
    const { data, error } = await supabase.from("app_branding").select("*").eq("id", "default").maybeSingle();
    const res = jsonResponse(200, error ? DEFAULTS : shape(data)); // table not created yet -> placeholders
    res.headers["Cache-Control"] = "no-store";
    return res;
  }

  if (["POST", "PUT", "DELETE"].indexOf(event.httpMethod) === -1) return jsonResponse(405, { error: "Method not allowed." });

  const { error: authErr } = await requirePermission(context, supabase, "perm_settings", "edit");
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

  const { error } = await supabase.from("app_branding").upsert({
    id: "default", app_name: next.appName, app_subtitle: next.appSubtitle, logo: next.logo, updated_at: new Date().toISOString()
  });
  if (error) {
    const missing = /app_branding/.test(error.message || "") && /exist|schema cache/i.test(error.message || "");
    return jsonResponse(500, { error: missing ? "Branding table missing — run db/branding-migration.sql in Supabase." : "Couldn't save branding." });
  }
  return jsonResponse(200, next);
};
