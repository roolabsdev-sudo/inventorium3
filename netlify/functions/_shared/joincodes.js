/**
 * Small helpers shared by the join-code functions (join-codes, join-requests, onboarding).
 *
 * A join code is 8 characters from a 31-letter alphabet with no look-alikes (no 0/O, 1/I/L),
 * shown to people as XXXX-XXXX. That is about 8.5 x 10^11 possibilities, and guessing one
 * needs a signed-in account with a confirmed email for every attempt.
 */
const crypto = require("crypto");

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 8;
const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;
const MAX_USES_LIMIT = 1000;

function generateCode() {
  let s = "";
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

/** What people type -> what is stored: upper case, letters and digits only ("abcd-2345" -> "ABCD2345"). */
function normalizeCode(input) {
  return String(input == null ? "" : input).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function formatCode(code) {
  const c = String(code || "");
  return c.length === CODE_LEN ? c.slice(0, 4) + "-" + c.slice(4) : c;
}

function levelOf(v) { return v === "edit" || v === "view" ? v : "none"; }

/**
 * How many people have used a code: requests that are waiting or were approved.
 * A declined or cancelled request frees its place. Returns null if the count couldn't be read.
 */
async function countUses(supabase, codeId) {
  const r = await supabase.from("join_requests").select("id", { count: "exact", head: true })
    .eq("code_id", codeId).in("status", ["pending", "approved"]);
  if (r.error) return null;
  return r.count || 0;
}

module.exports = {
  CODE_LEN, DEFAULT_DAYS, MAX_DAYS, MAX_USES_LIMIT,
  generateCode, normalizeCode, formatCode, levelOf, countUses
};
