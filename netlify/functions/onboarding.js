/**
 * /api/onboarding   (any signed-in person; they don't need to be on a roster yet)
 *
 * GET   -> { state }   where state is
 *            "member"        their email is on a venue's roster (they can use the app)
 *            "pending"       they asked to join a venue and are waiting for approval
 *            "needs_venue"   neither: they can create their own venue or join one with a code
 *          plus { venueName } when they are a member or pending, and { replaceable } for a member: true
 *          while the venue they own is still untouched, so joining another venue could replace it.
 *
 * POST { action: "join", code, name? }  -> ask to join the venue that code belongs to. Creates a
 *          pending request carrying the role and access the code promises; an admin there approves
 *          it on the Join requests page (piece 4). A bad, expired, turned-off or used-up code all
 *          get the same answer, so codes can't be probed. Returns { ok: true, venueName }.
 *          Add replaceVenue: true to swap the venue you just created by mistake for this one: your own
 *          venue is deleted, but ONLY if it is still untouched (see canReplaceVenue). Anything else is
 *          refused, so a real venue can never be wiped this way.
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
const { getSupabaseClient, getPendingRequest, getVenue, venueDb, jsonResponse } = require("./_shared/auth");
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

/**
 * Can this member throw away the venue they are on in order to join another?
 * Only when it is plainly a venue created by mistake: they own it, they are its only person, it holds
 * no inventory, shows, roles, locations, call lists or history, and nobody is waiting to join it.
 * Returns { ok: true, venue } or { ok: false, reason }.
 */
async function canReplaceVenue(supabase, email, employee) {
  const venue = await getVenue(supabase, employee.venue_id);
  if (!venue || venue.deleted_at || String(venue.owner_email || "").toLowerCase() !== email) {
    return { ok: false, reason: "You can only replace a venue you own." };
  }
  const db = venueDb(supabase, venue.id);
  const count = async function (table) {
    const r = await db.from(table).select("id", { count: "exact", head: true });
    return r.error ? null : (r.count || 0);
  };
  const people = await count("employees");
  if (people === null) return { ok: false, reason: "Couldn't check your venue. Try again." };
  if (people > 1) return { ok: false, reason: "Your venue already has other people in it, so it can't be replaced automatically." };
  for (const table of ["items", "shows", "show_roles", "call_list", "roles", "locations", "activity_log"]) {
    const n = await count(table);
    if (n === null) return { ok: false, reason: "Couldn't check your venue. Try again." };
    if (n > 0) return { ok: false, reason: "Your venue already has data in it, so it can't be replaced automatically." };
  }
  const waiting = await db.from("join_requests").select("id", { count: "exact", head: true }).eq("status", "pending");
  if (waiting.error) return { ok: false, reason: "Couldn't check your venue. Try again." };
  if (waiting.count > 0) return { ok: false, reason: "Someone is waiting to join your venue, so it can't be replaced automatically." };
  return { ok: true, venue: venue };
}

/**
 * Removes the venue canReplaceVenue approved, together with its one roster row and any codes.
 * If it can't finish, it puts back what it removed and reports failure, so nobody is left half-deleted.
 */
async function removeOwnVenue(supabase, venue, email) {
  const db = venueDb(supabase, venue.id);
  const mine = await db.from("employees").select("*").eq("email", email).maybeSingle();
  if (mine.error || !mine.data) return false;
  const gone = await db.from("employees").delete().eq("email", email);
  if (gone.error) return false;
  await db.from("join_codes").delete();
  await db.from("join_requests").delete();
  const del = await supabase.from("venues").delete().eq("id", venue.id).eq("owner_email", email);
  if (del.error) {
    await db.from("employees").insert(mine.data); // best effort: put the roster row back
    return false;
  }
  return true;
}

async function joinWithCode(supabase, user, email, b, replace) {
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

  if (replace) {
    // The request is safely made and the code is good: now (and only now) let go of the venue made by mistake.
    if (!(await removeOwnVenue(supabase, replace, email))) {
      await supabase.from("join_requests").delete().eq("id", made.data.id);
      return jsonResponse(500, { error: "Couldn't replace your venue, so nothing was changed. Try again." });
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
      const swap = await canReplaceVenue(supabase, email, found.employee);
      return jsonResponse(200, { state: "member", venueName: venue ? venue.name : "", replaceable: swap.ok });
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

  if (b.action === "join" && b.replaceVenue === true && found.employee) {
    const swap = await canReplaceVenue(supabase, email, found.employee);
    if (!swap.ok) return jsonResponse(409, { error: swap.reason });
    return joinWithCode(supabase, user, email, b, swap.venue);
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
