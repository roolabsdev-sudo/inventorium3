/**
 * Shared auth + permission helpers for Netlify Functions.
 *
 * Security model:
 *  - The browser never talks to Supabase directly and never holds the
 *    service-role key. Every read/write goes through a Netlify Function.
 *  - Netlify Identity authenticates the person (who they are). This file
 *    then looks up their matching `employees` row by email to find out
 *    what they're allowed to do (their permissions).
 *  - A Netlify Function automatically receives the caller's verified
 *    Identity token as `context.clientContext.user` — this is set by
 *    Netlify itself after verifying the JWT, so a function can trust it
 *    without re-validating the token by hand.
 *  - If `context.clientContext.user` is missing, the request did not come
 *    from a logged-in session (or Identity isn't enabled yet) and must be
 *    rejected for anything but the most public reads, if any.
 */


function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables. " +
      "Set these in Netlify (Site settings > Environment variables) — see /db/README.md."
    );
  }
  const { createClient } = require("@supabase/supabase-js"); // loaded here so tests can run without it
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * This email's join request that is waiting for approval, or null. Before db/venues-onboarding.sql
 * has been run the table doesn't exist; that is treated as "no request" so the site keeps working.
 */
async function getPendingRequest(supabase, email) {
  const { data, error } = await supabase.from("join_requests").select("*").eq("email", email).eq("status", "pending").limit(1);
  if (error) return null;
  return (data && data[0]) || null;
}

/** True if this email has a join request waiting for approval. */
async function hasPendingRequest(supabase, email) {
  return !!(await getPendingRequest(supabase, email));
}

/**
 * Resolves the calling employee from the Netlify Identity context.
 * Returns { employee, error } — error is a { statusCode, message, code? } shape
 * ready to hand straight back to the client on failure.
 */
async function getCallerEmployee(context, supabase) {
  const identityUser = context.clientContext && context.clientContext.user;
  if (!identityUser || !identityUser.email) {
    return { employee: null, error: { statusCode: 401, message: "Not logged in." } };
  }

  const { data, error } = await supabase
    .from("employees")
    .select("*")
    .eq("email", identityUser.email.toLowerCase())
    .maybeSingle();

  if (error) {
    return { employee: null, error: { statusCode: 500, message: "Could not look up permissions." } };
  }
  if (!data) {
    // Not on any roster. There is no automatic admin any more: the person either has a
    // join request waiting for approval ("pending") or needs to create their own venue
    // ("needs_onboarding"). The welcome page handles both; see netlify/functions/onboarding.js.
    const email = identityUser.email.toLowerCase();
    if (await hasPendingRequest(supabase, email)) {
      return { employee: null, error: { statusCode: 403, code: "pending", message: "Your request to join is waiting for approval." } };
    }
    return {
      employee: null,
      error: { statusCode: 403, code: "needs_onboarding", message: "Your login isn't linked to a venue yet." }
    };
  }
  if (!data.active) {
    return { employee: null, error: { statusCode: 403, message: "Your employee record is inactive." } };
  }
  if (!data.venue_id) {
    return { employee: null, error: { statusCode: 500, message: "Your account isn't attached to a venue." } };
  }

  return { employee: data, error: null };
}

/**
 * Checks the employee's permission level for a given page/resource against
 * the minimum level required ('view' or 'edit'). 'edit' satisfies a 'view'
 * requirement; 'view' does not satisfy an 'edit' requirement; 'none' never
 * satisfies anything.
 *
 * permKey is one of: perm_inventory | perm_call_list | perm_employees | perm_settings
 */
function hasPermission(employee, permKey, minLevel) {
  var level = employee[permKey] || "none";
  if (minLevel === "view") return level === "view" || level === "edit";
  if (minLevel === "edit") return level === "edit";
  return false;
}

/**
 * Convenience wrapper: resolves the caller and checks a permission in one
 * call. Returns { employee, error }. On failure, error is ready to return
 * directly as the function's HTTP response body.
 */
async function requirePermission(context, supabase, permKey, minLevel) {
  const { employee, error } = await getCallerEmployee(context, supabase);
  if (error) return { employee: null, error: error };

  if (!hasPermission(employee, permKey, minLevel)) {
    return {
      employee: null,
      error: {
        statusCode: 403,
        message: minLevel === "edit"
          ? "You have view-only access to this page."
          : "You don't have access to this page."
      }
    };
  }
  return { employee: employee, error: null };
}

/**
 * Calls the Netlify Identity admin API (create users, set passwords, delete users).
 * Netlify hands every function an admin-scoped token in
 * context.clientContext.identity when Identity is enabled — it is only ever
 * used here on the server, never sent to the browser.
 */
async function identityAdmin(context, method, path, body) {
  const identity = context.clientContext && context.clientContext.identity;
  if (!identity || !identity.url || !identity.token) {
    throw new Error("Netlify Identity isn't enabled for this site (no admin token available).");
  }
  const res = await fetch(identity.url + path, {
    method: method,
    headers: { Authorization: "Bearer " + identity.token, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = { msg: text }; }
  if (!res.ok) {
    const err = new Error((json && (json.msg || json.error_description || json.message)) || ("Identity error " + res.status));
    err.status = res.status;
    throw err;
  }
  return json;
}

async function findIdentityUserByEmail(context, email) {
  const list = await identityAdmin(context, "GET", "/admin/users?per_page=1000");
  const users = (list && list.users) || [];
  return users.find(function (u) { return String(u.email).toLowerCase() === email.toLowerCase(); }) || null;
}


/**
 * venueDb(supabase, venueId) — THE way functions touch data.
 *
 * It mirrors supabase.from(table), but every query is pinned to one venue:
 *   select / update / delete  ->  automatically add  .eq("venue_id", venueId)
 *   insert / upsert           ->  stamp venue_id on every row (any venue_id the
 *                                 caller sent is overwritten) and make upsert match
 *                                 on (venue_id, <your onConflict>), so an id that
 *                                 exists in another venue can never be overwritten.
 *
 * Usage:   const db = venueDb(supabase, me.venue_id);
 *          db.from("items").select("*").eq("id", id).maybeSingle();
 *
 * Rule for this codebase: after the caller is resolved, functions use `db`, never
 * the raw `supabase` client, for data tables. The only unscoped reads allowed are
 * the explicit helpers in this file (emailTaken, venue lookups).
 */
function venueDb(supabase, venueId) {
  if (!venueId) throw new Error("venueDb needs a venue id.");
  function tag(rows) {
    const one = function (r) { return Object.assign({}, r, { venue_id: venueId }); };
    return Array.isArray(rows) ? rows.map(one) : one(rows);
  }
  return {
    venueId: venueId,
    from: function (table) {
      return {
        select: function (columns, opts) {
          return supabase.from(table).select(columns || "*", opts).eq("venue_id", venueId);
        },
        insert: function (rows) {
          return supabase.from(table).insert(tag(rows));
        },
        upsert: function (rows, opts) {
          const o = Object.assign({}, opts);
          o.onConflict = "venue_id," + (o.onConflict || "id");
          return supabase.from(table).upsert(tag(rows), o);
        },
        update: function (patch) {
          return supabase.from(table).update(patch).eq("venue_id", venueId);
        },
        delete: function () {
          return supabase.from(table).delete().eq("venue_id", venueId);
        }
      };
    }
  };
}

/**
 * Emails are unique across ALL venues (one venue per email), so this check is
 * deliberately unscoped. It only reports the person's name when they are in the
 * caller's own venue, so one venue can't learn who is on another venue's roster.
 * Returns { taken, sameVenueName }.
 */
async function emailTaken(supabase, email, venueId, exceptId) {
  let q = supabase.from("employees").select("id,name,venue_id").eq("email", email);
  const { data } = await q;
  const clash = (data || []).find(function (r) { return !(r.venue_id === venueId && r.id === exceptId); });
  if (!clash) return { taken: false, sameVenueName: null };
  return { taken: true, sameVenueName: clash.venue_id === venueId ? clash.name : null };
}

/** The caller's venue row (name, subtitle, logo, owner...). */
async function getVenue(supabase, venueId) {
  const { data } = await supabase.from("venues").select("*").eq("id", venueId).maybeSingle();
  return data || null;
}

function jsonResponse(statusCode, body) {
  return {
    statusCode: statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

module.exports = {
  getSupabaseClient: getSupabaseClient,
  getCallerEmployee: getCallerEmployee,
  getPendingRequest: getPendingRequest,
  hasPendingRequest: hasPendingRequest,
  hasPermission: hasPermission,
  requirePermission: requirePermission,
  identityAdmin: identityAdmin,
  findIdentityUserByEmail: findIdentityUserByEmail,
  venueDb: venueDb,
  emailTaken: emailTaken,
  getVenue: getVenue,
  jsonResponse: jsonResponse
};
