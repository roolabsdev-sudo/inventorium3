/**
 * /api/onboarding   (any signed-in person; they don't need to be on a roster yet)
 *
 * GET   -> { state }   where state is
 *            "member"        their email is on a venue's roster (they can use the app)
 *            "pending"       they asked to join a venue and are waiting for approval
 *            "needs_venue"   neither: they can create their own venue or join one with a code
 *          plus { venueName } when they are a member or pending.
 *
 * POST { action: "join", code, name? }  -> ask to join the venue that code belongs to. Creates a
 *          pending request carrying the role and access the code promises; an admin there approves
 *          it on the Join requests page (piece 4). A bad, expired, turned-off or used-up code all
 *          get the same answer, so codes can't be probed. Returns { ok: true, venueName }.
 * POST { action: "cancel" }             -> withdraw your own waiting request.
 * POST { name, subtitle?, logo? }       -> create a venue; the caller becomes its owner and admin.
 *          Refused (409) if the caller is already on a roster, is waiting on a join request, or
 *          already owns a venue: one venue per email, and one place per person.
 *          Returns { ok: true, venueId }.
 *
 * The venue and its first admin are created together. If the admin row can't be written (for
 * example two sign-ups race for the same email) the new venue is removed again, so nobody is
 * ever left owning an empty venue they can't get into.
 */
const crypto = require("crypto");
const { getSupabaseClient, getPendingRequest, getVenue, jsonResponse } = require("./_shared/auth");
const { CODE_LEN, normalizeCode, countUses } = require("./_shared/joincodes");

const BAD_CODE = "That code isn't valid. It may have expired, been turned off, or been used up. Ask your admin for a new one.";

const LOGO_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

async function lookup(supabase, email) {
  const emp = await supabase.from("employees").select("id,venue_id,active").eq("email", email).maybeSingle();
  if (emp.error) return { error: "Could not check your account." };
  if (emp.data) return { employee: emp.data };
  const owned = await supabase.from("venues").select("id").eq("owner_email", email).is("deleted_at", null).limit(1);
  if (owned.error) return { error: "Could not check your account." };
  return { ownedVenue: owned.data && owned.data[0] || null, pending: await getPendingRequest(supabase, email) };
}

async function joinWithCode(supabase, user, email, b) {
  const norm = normalizeCode(b.code);
  if (norm.length !== CODE_LEN) return jsonResponse(400, { error: BAD_CODE });

  const c = await supabase.from("join_codes").select("*").eq("code", norm).is("revoked_at", null).maybeSingle();
  if (c.error) return jsonResponse(500, { error: "Couldn't check that code. Try again." });
  const code = c.data;
  if (!code || new Date(code.expires_at).getTime() <= Date.now()) return jsonResponse(400, { error: BAD_CODE });

  const venue = await getVenue(supabase, code.venue_id);
  if (!venue || venue.deleted_at) return jsonResponse(400, { error: BAD_CODE });

  if (code.max_uses != null) {
    const used = await countUses(supabase, code.id);
    if (used === null) return jsonResponse(500, { error: "Couldn't check that code. Try again." });
    if (used >= code.max_uses) return jsonResponse(400, { error: BAD_CODE });
  }

  const meta = user.user_metadata || {};
  const person = String(b.name || "").trim() || meta.full_name || email.split("@")[0];
  const made = await supabase.from("join_requests").insert({
    venue_id: code.venue_id, email: email, name: String(person).slice(0, 80), status: "pending",
    code_id: code.id, role_id: code.role_id || null,
    perm_inventory: code.perm_inventory, perm_call_list: code.perm_call_list,
    perm_employees: code.perm_employees, perm_settings: code.perm_settings,
    requested_at: new Date().toISOString()
  }).select().single();
  if (made.error) {
    if (made.error.code === "23505") return jsonResponse(409, { error: "Your request to join a venue is still waiting for approval." });
    return jsonResponse(500, { error: "Couldn't send your request. Try again." });
  }

  // Two people using the last place on a code at the same moment could both pass the check above.
  // Count again now that our request exists; if the code is over its limit, take ours back.
  if (code.max_uses != null) {
    const after = await countUses(supabase, code.id);
    if (after === null || after > code.max_uses) {
      await supabase.from("join_requests").delete().eq("id", made.data.id);
      return after === null ? jsonResponse(500, { error: "Couldn't send your request. Try again." }) : jsonResponse(400, { error: BAD_CODE });
    }
  }
  return jsonResponse(200, { ok: true, venueName: venue.name });
}

exports.handler = async function (event, context) {
  const user = context.clientContext && context.clientContext.user;
  if (!user || !user.email) return jsonResponse(401, { error: "Not logged in." });
  const email = String(user.email).toLowerCase().trim();

  let supabase;
  try { supabase = getSupabaseClient(); } catch (e) { return jsonResponse(500, { error: e.message }); }

  const found = await lookup(supabase, email);
  if (found.error) return jsonResponse(500, { error: found.error });

  if (event.httpMethod === "GET") {
    if (found.employee) {
      const venue = await getVenue(supabase, found.employee.venue_id);
      return jsonResponse(200, { state: "member", venueName: venue ? venue.name : "" });
    }
    if (found.pending) {
      const venue = await getVenue(supabase, found.pending.venue_id);
      return jsonResponse(200, { state: "pending", venueName: venue ? venue.name : "" });
    }
    return jsonResponse(200, { state: "needs_venue" });
  }

  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed." });

  let b;
  try { b = JSON.parse(event.body || "{}"); } catch (e) { return jsonResponse(400, { error: "Bad request." }); }

  if (b.action === "cancel") {
    // Only ever this caller's own request: matched on their verified email, never on anything they send.
    await supabase.from("join_requests").update({ status: "cancelled", decided_at: new Date().toISOString() }).eq("email", email).eq("status", "pending");
    return jsonResponse(200, { ok: true });
  }

  if (found.employee) return jsonResponse(409, { error: "You already belong to a venue." });
  if (found.ownedVenue) return jsonResponse(409, { error: "You already own a venue." });
  if (found.pending) return jsonResponse(409, { error: "Your request to join a venue is still waiting for approval." });

  if (b.action === "join") return joinWithCode(supabase, user, email, b);

  const name = String(b.name || "").trim();
  const subtitle = String(b.subtitle || "").trim();
  const logo = b.logo == null || b.logo === "" ? null : String(b.logo);
  if (!name) return jsonResponse(400, { error: "Enter a name for your venue." });
  if (name.length > 60) return jsonResponse(400, { error: "Name must be 60 characters or fewer." });
  if (subtitle.length > 40) return jsonResponse(400, { error: "Subtitle must be 40 characters or fewer." });
  if (logo && (logo.length > 400000 || !LOGO_RE.test(logo))) return jsonResponse(400, { error: "Logo must be a PNG, JPEG or WebP image under about 300 KB." });

  const venueId = crypto.randomUUID();
  const made = await supabase.from("venues").insert({ id: venueId, name: name, subtitle: subtitle, logo: logo, owner_email: email, created_at: new Date().toISOString() });
  if (made.error) {
    return jsonResponse(made.error.code === "23505" ? 409 : 500, { error: made.error.code === "23505" ? "You already own a venue." : "Couldn't create the venue." });
  }

  const person = (user.user_metadata && user.user_metadata.full_name) || email.split("@")[0];
  const admin = await supabase.from("employees").insert({
    venue_id: venueId, id: "ADMIN-1", name: String(person).slice(0, 80), email: email, active: true,
    perm_inventory: "edit", perm_call_list: "edit", perm_employees: "edit", perm_settings: "edit"
  });
  if (admin.error) {
    await supabase.from("venues").delete().eq("id", venueId); // undo: only this venue, by its own new id
    return jsonResponse(admin.error.code === "23505" ? 409 : 500, {
      error: admin.error.code === "23505" ? "You already belong to a venue." : "Couldn't set up your account in the new venue."
    });
  }
  return jsonResponse(200, { ok: true, venueId: venueId });
};
