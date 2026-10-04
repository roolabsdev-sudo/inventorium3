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

const { createClient } = require("@supabase/supabase-js");

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables. " +
      "Set these in Netlify (Site settings > Environment variables) — see /db/README.md."
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Resolves the calling employee from the Netlify Identity context.
 * Returns { employee, error } — error is a { statusCode, message } shape
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
    // First-run bootstrap: if nobody exists yet (or the email is listed in the
    // ADMIN_EMAILS env var), the first person to log in becomes a full admin so
    // there is always a way to create the rest of the roster.
    const adminEmails = String(process.env.ADMIN_EMAILS || "")
      .toLowerCase().split(",").map(function (x) { return x.trim(); }).filter(Boolean);
    const email = identityUser.email.toLowerCase();
    let allowBootstrap = adminEmails.indexOf(email) !== -1;
    if (!allowBootstrap) {
      const { count } = await supabase.from("employees").select("id", { count: "exact", head: true });
      allowBootstrap = count === 0;
    }
    if (allowBootstrap) {
      const name = (identityUser.user_metadata && identityUser.user_metadata.full_name) || email.split("@")[0];
      const row = {
        id: "ADMIN-1", name: name, email: email, active: true,
        perm_inventory: "edit", perm_call_list: "edit", perm_employees: "edit", perm_settings: "edit"
      };
      const { data: created, error: createErr } = await supabase.from("employees").insert(row).select().single();
      if (createErr) {
        // ADMIN-1 may already be taken (another admin-listed email logged in first); pick a free id.
        row.id = "ADMIN-" + Date.now().toString().slice(-6);
        const retry = await supabase.from("employees").insert(row).select().single();
        if (retry.error) return { employee: null, error: { statusCode: 500, message: "Could not create the first admin." } };
        return { employee: retry.data, error: null };
      }
      return { employee: created, error: null };
    }
    return {
      employee: null,
      error: {
        statusCode: 403,
        message: "Your login isn't linked to an employee record. Ask an advisor to add your email on the Employees page."
      }
    };
  }
  if (!data.active) {
    return { employee: null, error: { statusCode: 403, message: "Your employee record is inactive." } };
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
  hasPermission: hasPermission,
  requirePermission: requirePermission,
  identityAdmin: identityAdmin,
  findIdentityUserByEmail: findIdentityUserByEmail,
  jsonResponse: jsonResponse
};
