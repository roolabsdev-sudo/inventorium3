/**
 * Shared helpers for scanner devices (scanner-codes, scanner-signin, scanner).
 *
 * A scanner device is NOT a person. It has no Netlify Identity login. It holds a random token that
 * was handed out when someone typed a valid scanner code at the sign-in page. The server stores
 * only a SHA-256 hash of that token, so a leaked database can't be used to act as a device.
 *
 * The token is only ever accepted by the `scanner` function, which can do exactly three things:
 * read the scan data, check items out/in, and use up consumables. Every other function requires a
 * Netlify Identity login and so refuses a scanner device. That is what keeps a device scan-only.
 */
const crypto = require("crypto");

const MAX_HOURS = 24 * 7;
const DEFAULT_HOURS = 24;
const MAX_DEVICES_PER_CODE = 10;
const MAX_ACTIVE_DEVICES = 10;   // per venue
const MAX_LIVE_CODES = 20;       // per venue

function newToken() { return crypto.randomBytes(32).toString("hex"); }
function hashToken(token) { return crypto.createHash("sha256").update(String(token)).digest("hex"); }

/**
 * Resolves the calling scanner device from the X-Scanner-Token header.
 * Returns { device, venue, error } ; error is { statusCode, message } ready to send back.
 * A removed device, a missing venue and a deleted venue are all the same 401.
 */
async function getScannerDevice(event, supabase) {
  const headers = event.headers || {};
  let token = null;
  for (const k of Object.keys(headers)) if (k.toLowerCase() === "x-scanner-token") token = headers[k];
  const bad = { statusCode: 401, message: "This scanner has been signed out. Sign in again with a new scanner code." };
  if (!token || typeof token !== "string" || token.length > 200) return { device: null, venue: null, error: bad };

  const found = await supabase.from("scanner_devices").select("*").eq("token_hash", hashToken(token)).maybeSingle();
  if (found.error) return { device: null, venue: null, error: { statusCode: 500, message: "Couldn't check this scanner." } };
  if (!found.data || found.data.revoked_at) return { device: null, venue: null, error: bad };

  const v = await supabase.from("venues").select("*").eq("id", found.data.venue_id).maybeSingle();
  if (v.error) return { device: null, venue: null, error: { statusCode: 500, message: "Couldn't check this scanner." } };
  if (!v.data || v.data.deleted_at) return { device: null, venue: null, error: bad };

  return { device: found.data, venue: v.data, error: null };
}

module.exports = {
  MAX_HOURS, DEFAULT_HOURS, MAX_DEVICES_PER_CODE, MAX_ACTIVE_DEVICES, MAX_LIVE_CODES,
  newToken, hashToken, getScannerDevice
};
