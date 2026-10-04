/**
 * /api/scanner-codes   (requires perm_employees = edit, like join codes)
 *
 * GET                  -> { codes: [...], devices: [...] }
 *                         codes   = this venue's codes that haven't been turned off, newest first:
 *                                   { id, code, label, maxDevices, uses, expiresAt, createdAt, state }
 *                                   state: "active" | "expired" | "used_up"
 *                         devices = scanner devices that are signed in:
 *                                   { id, label, createdAt, lastSeenAt }
 * POST { label?, hours?, maxDevices? }
 *                      -> make a code. hours is 1-168 (default 24), maxDevices 1-10 (default 1).
 * DELETE ?id=          -> turn a code off (no new device can use it; devices already signed in stay)
 * DELETE ?device=      -> sign a device out (it stops working on its next tap)
 *
 * Everything is pinned to the caller's venue through venueDb().
 */
const { getSupabaseClient, requirePermission, venueDb, jsonResponse } = require("./_shared/auth");
const J = require("./_shared/joincodes");
const S = require("./_shared/scanner");

function view(row, uses, now) {
  let state = "active";
  if (new Date(row.expires_at).getTime() <= now) state = "expired";
  else if (uses >= row.max_devices) state = "used_up";
  return {
    id: row.id, code: J.formatCode(row.code), label: row.label || "",
    maxDevices: row.max_devices, uses: uses,
    expiresAt: row.expires_at, createdAt: row.created_at, state: state
  };
}

exports.handler = async function (event, context) {
  let supabase;
  try { supabase = getSupabaseClient(); } catch (e) { return jsonResponse(500, { error: e.message }); }

  const { employee: me, error } = await requirePermission(context, supabase, "perm_employees", "edit");
  if (error) return jsonResponse(error.statusCode, { error: error.message });
  const db = venueDb(supabase, me.venue_id);
  const qs = event.queryStringParameters || {};

  if (event.httpMethod === "GET") {
    const codes = await db.from("scanner_codes").select("*").is("revoked_at", null).order("created_at", { ascending: false }).limit(100);
    // Every device ever made from a code counts towards that code's limit, signed in or not,
    // so signing a device out never hands its place on the code to somebody else.
    const everyDevice = await db.from("scanner_devices").select("id,code_id,label,created_at,last_seen_at,revoked_at").order("created_at", { ascending: false });
    if (codes.error || everyDevice.error) return jsonResponse(500, { error: "Couldn't load scanner codes." });
    const used = {};
    (everyDevice.data || []).forEach(function (d) { if (d.code_id != null) used[d.code_id] = (used[d.code_id] || 0) + 1; });
    const now = Date.now();
    return jsonResponse(200, {
      codes: (codes.data || []).map(function (c) { return view(c, used[c.id] || 0, now); }),
      devices: (everyDevice.data || []).filter(function (d) { return !d.revoked_at; }).slice(0, 100).map(function (d) {
        return { id: d.id, label: d.label || "", createdAt: d.created_at, lastSeenAt: d.last_seen_at || null };
      })
    });
  }

  if (event.httpMethod === "DELETE") {
    if (qs.device != null) {
      const id = Number(qs.device);
      if (!Number.isInteger(id)) return jsonResponse(400, { error: "device query parameter is required." });
      const found = await db.from("scanner_devices").select("id").eq("id", id).is("revoked_at", null).maybeSingle();
      if (found.error) return jsonResponse(500, { error: "Couldn't sign that scanner out." });
      if (!found.data) return jsonResponse(404, { error: "Scanner not found." });
      const done = await db.from("scanner_devices").update({ revoked_at: new Date().toISOString() }).eq("id", id);
      if (done.error) return jsonResponse(500, { error: "Couldn't sign that scanner out." });
      return jsonResponse(200, { ok: true });
    }
    const id = Number(qs.id);
    if (!Number.isInteger(id)) return jsonResponse(400, { error: "id query parameter is required." });
    const found = await db.from("scanner_codes").select("id").eq("id", id).is("revoked_at", null).maybeSingle();
    if (found.error) return jsonResponse(500, { error: "Couldn't turn that code off." });
    if (!found.data) return jsonResponse(404, { error: "Code not found." });
    const done = await db.from("scanner_codes").update({ revoked_at: new Date().toISOString() }).eq("id", id);
    if (done.error) return jsonResponse(500, { error: "Couldn't turn that code off." });
    return jsonResponse(200, { ok: true });
  }

  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed." });

  let b;
  try { b = JSON.parse(event.body || "{}"); } catch (e) { return jsonResponse(400, { error: "Invalid JSON body." }); }

  const hours = b.hours == null || b.hours === "" ? S.DEFAULT_HOURS : Number(b.hours);
  if (!Number.isInteger(hours) || hours < 1 || hours > S.MAX_HOURS) return jsonResponse(400, { error: "Time to enter the code must be between 1 and " + S.MAX_HOURS + " hours." });
  const maxDevices = b.maxDevices == null || b.maxDevices === "" ? 1 : Number(b.maxDevices);
  if (!Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > S.MAX_DEVICES_PER_CODE) return jsonResponse(400, { error: "Devices must be a whole number from 1 to " + S.MAX_DEVICES_PER_CODE + "." });
  const label = String(b.label == null ? "" : b.label).trim().slice(0, 60);

  // Small cap on codes that are still usable, so one venue can't pile up codes without limit.
  const live = await db.from("scanner_codes").select("id,expires_at").is("revoked_at", null);
  if (live.error) return jsonResponse(500, { error: "Couldn't create the code." });
  const stillValid = (live.data || []).filter(function (c) { return new Date(c.expires_at).getTime() > Date.now(); }).length;
  if (stillValid >= S.MAX_LIVE_CODES) return jsonResponse(409, { error: "You already have " + S.MAX_LIVE_CODES + " scanner codes that haven't expired. Turn some off first." });

  const row = {
    label: label || null, max_devices: maxDevices,
    expires_at: new Date(Date.now() + hours * 3600000).toISOString(),
    created_by: me.id, created_at: new Date().toISOString(), revoked_at: null
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const made = await db.from("scanner_codes").insert(Object.assign({ code: J.generateCode() }, row)).select().single();
    if (!made.error) return jsonResponse(200, { code: view(made.data, 0, Date.now()) });
    if (made.error.code !== "23505") return jsonResponse(500, { error: "Couldn't create the code." });
  }
  return jsonResponse(500, { error: "Couldn't create a unique code. Try again." });
};
