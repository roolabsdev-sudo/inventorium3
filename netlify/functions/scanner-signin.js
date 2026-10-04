/**
 * /api/scanner-signin   (public: this is how a device with no login gets in)
 *
 * POST { code, name? }  -> { token, venueName, label }
 *
 * Someone types a scanner code on the sign-in page. If it is valid, this makes a scanner device
 * for the code's venue and returns its token ONCE. The browser keeps the token; the server keeps only a hash.
 * From then on that browser can only use the scanner function (see _shared/scanner.js).
 *
 * A wrong, expired, turned-off, used-up or deleted-venue code all get the same message,
 * so codes can't be probed to learn which ones exist.
 */
const { getSupabaseClient, jsonResponse } = require("./_shared/auth");
const J = require("./_shared/joincodes");
const S = require("./_shared/scanner");

const BAD_CODE = "That code isn't valid. Check it, or ask an admin for a new one.";

async function deviceCount(supabase, codeId) {
  const r = await supabase.from("scanner_devices").select("id", { count: "exact", head: true }).eq("code_id", codeId);
  return r.error ? null : (r.count || 0);
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed." });
  let supabase;
  try { supabase = getSupabaseClient(); } catch (e) { return jsonResponse(500, { error: e.message }); }

  let b;
  try { b = JSON.parse(event.body || "{}"); } catch (e) { return jsonResponse(400, { error: "Invalid JSON body." }); }
  const code = J.normalizeCode(b.code);
  if (code.length !== J.CODE_LEN) return jsonResponse(400, { error: BAD_CODE });

  const found = await supabase.from("scanner_codes").select("*").eq("code", code).maybeSingle();
  if (found.error) return jsonResponse(500, { error: "Couldn't check that code. Try again." });
  const c = found.data;
  if (!c || c.revoked_at || new Date(c.expires_at).getTime() <= Date.now()) return jsonResponse(400, { error: BAD_CODE });

  const v = await supabase.from("venues").select("*").eq("id", c.venue_id).maybeSingle();
  if (v.error) return jsonResponse(500, { error: "Couldn't check that code. Try again." });
  if (!v.data || v.data.deleted_at) return jsonResponse(400, { error: BAD_CODE });

  const used = await deviceCount(supabase, c.id);
  if (used == null) return jsonResponse(500, { error: "Couldn't check that code. Try again." });
  if (used >= c.max_devices) return jsonResponse(400, { error: BAD_CODE });

  // A venue can only have so many scanners signed in at once.
  const active = await supabase.from("scanner_devices").select("id", { count: "exact", head: true }).eq("venue_id", c.venue_id).is("revoked_at", null);
  if (active.error) return jsonResponse(500, { error: "Couldn't check that code. Try again." });
  if ((active.count || 0) >= S.MAX_ACTIVE_DEVICES) {
    return jsonResponse(409, { error: "This venue already has " + S.MAX_ACTIVE_DEVICES + " scanners signed in. An admin needs to sign one out first." });
  }

  const token = S.newToken();
  const label = String(b.name == null ? "" : b.name).trim().slice(0, 60) || c.label || "Scanner";
  const made = await supabase.from("scanner_devices").insert({
    venue_id: c.venue_id, code_id: c.id, token_hash: S.hashToken(token), label: label,
    created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), revoked_at: null
  }).select().single();
  if (made.error) return jsonResponse(500, { error: "Couldn't set up this scanner. Try again." });

  // Two people typing the last place on a code at the same moment can both pass the check above.
  // Count again now that our row exists; if the code is over its limit, give our place back.
  const after = await deviceCount(supabase, c.id);
  if (after == null || after > c.max_devices) {
    await supabase.from("scanner_devices").delete().eq("id", made.data.id);
    return jsonResponse(400, { error: BAD_CODE });
  }

  return jsonResponse(200, { token: token, venueName: v.data.name || "", label: label });
};
