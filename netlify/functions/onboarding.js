/**
 * /api/onboarding   (any signed-in person; they don't need to be on a roster yet)
 *
 * GET   -> { state }   where state is
 *            "member"        their email is on a venue's roster (they can use the app)
 *            "pending"       they asked to join a venue and are waiting for approval
 *            "needs_venue"   neither: they can create their own venue
 *          plus { venueName } when they are a member.
 *
 * POST { name, subtitle?, logo? }  -> create a venue; the caller becomes its owner and admin.
 *          Refused (409) if the caller is already on a roster, is waiting on a join request, or
 *          already owns a venue: one venue per email, and one place per person.
 *          Returns { ok: true, venueId }.
 *
 * The venue and its first admin are created together. If the admin row can't be written (for
 * example two sign-ups race for the same email) the new venue is removed again, so nobody is
 * ever left owning an empty venue they can't get into.
 */
const crypto = require("crypto");
const { getSupabaseClient, hasPendingRequest, getVenue, jsonResponse } = require("./_shared/auth");

const LOGO_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

async function lookup(supabase, email) {
  const emp = await supabase.from("employees").select("id,venue_id,active").eq("email", email).maybeSingle();
  if (emp.error) return { error: "Could not check your account." };
  if (emp.data) return { employee: emp.data };
  const owned = await supabase.from("venues").select("id").eq("owner_email", email).is("deleted_at", null).limit(1);
  if (owned.error) return { error: "Could not check your account." };
  return { ownedVenue: owned.data && owned.data[0] || null, pending: await hasPendingRequest(supabase, email) };
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
    return jsonResponse(200, { state: found.pending ? "pending" : "needs_venue" });
  }

  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed." });

  if (found.employee) return jsonResponse(409, { error: "You already belong to a venue." });
  if (found.ownedVenue) return jsonResponse(409, { error: "You already own a venue." });
  if (found.pending) return jsonResponse(409, { error: "Your request to join a venue is still waiting for approval." });

  let b;
  try { b = JSON.parse(event.body || "{}"); } catch (e) { return jsonResponse(400, { error: "Bad request." }); }
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
