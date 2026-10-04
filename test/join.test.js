/**
 * Piece 4: join codes and the approval screen.
 *  - only an admin (Employees: edit) can make, list or turn off codes and decide requests
 *  - a code carries a role + access preset, an expiry and an optional use limit
 *  - using a code creates a PENDING request only; nothing is granted until an admin approves
 *  - approving adds the person to that venue's roster with exactly the preset
 *  - one venue can never see, approve, decline or turn off another venue's codes and requests
 *  - bad / expired / turned-off / used-up codes are indistinguishable to the person typing them
 *
 * Run:  npm test
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { makeFake } = require("./fake-supabase");

const FN = path.join(__dirname, "..", "netlify", "functions");
const auth = require(path.join(FN, "_shared", "auth"));
let db;
auth.getSupabaseClient = () => db;

const bootstrap = require(path.join(FN, "bootstrap")).handler;
const onboarding = require(path.join(FN, "onboarding")).handler;
const joinCodes = require(path.join(FN, "join-codes")).handler;
const joinRequests = require(path.join(FN, "join-requests")).handler;
const items = require(path.join(FN, "items")).handler;
const { normalizeCode } = require(path.join(FN, "_shared", "joincodes"));

const A = "venue-a", B = "venue-b";
const full = { perm_inventory: "edit", perm_call_list: "edit", perm_employees: "edit", perm_settings: "edit", active: true };
const none = { perm_inventory: "none", perm_call_list: "none", perm_employees: "none", perm_settings: "none", active: true };

function seed() {
  return {
    venues: [
      { id: A, name: "Venue A", subtitle: "", logo: null, owner_email: "alice@a.test", deleted_at: null, created_at: "2026-01-01" },
      { id: B, name: "Venue B", subtitle: "", logo: null, owner_email: "bob@b.test", deleted_at: null, created_at: "2026-02-01" }
    ],
    employees: [
      { venue_id: A, id: "ADMIN-1", name: "Alice-A", email: "alice@a.test", ...full },
      { venue_id: A, id: "ID-1000", name: "Viewer-A", email: "viewer@a.test", ...none, perm_employees: "view" },
      { venue_id: B, id: "ADMIN-1", name: "Bob-B", email: "bob@b.test", ...full }
    ],
    roles: [{ venue_id: A, id: "role-crew", name: "Crew" }, { venue_id: B, id: "role-b", name: "B-only" }],
    items: [
      { venue_id: A, id: "LX-0001", name: "A lamp", status: "ok", location: "Booth", restricted_to: [], holder: null },
      { venue_id: B, id: "LX-0001", name: "B lamp", status: "ok", location: "Booth", restricted_to: [], holder: null }
    ]
  };
}

const ctx = (email, meta) => ({ clientContext: { user: { email, user_metadata: meta || {} } } });
const call = (fn, who, method, body, qs) =>
  fn({ httpMethod: method, queryStringParameters: qs || {}, body: body ? JSON.stringify(body) : undefined }, who)
    .then((r) => ({ status: r.statusCode, json: JSON.parse(r.body) }));

const alice = ctx("alice@a.test"), bob = ctx("bob@b.test"), viewer = ctx("viewer@a.test"), sam = ctx("sam@new.test");
const crewPreset = { roleId: "role-crew", permInventory: "view", permCallList: "view", permEmployees: "none", permSettings: "none" };

const makeCode = (who, body) => call(joinCodes, who || alice, "POST", body || crewPreset);
const join = (who, code, extra) => call(onboarding, who || sam, "POST", { action: "join", code, ...(extra || {}) });
const pendingFor = (venue) => (db.tables.join_requests || []).filter((r) => r.venue_id === venue && r.status === "pending");

test.beforeEach(() => { db = makeFake(seed()); });

/* ---------- making and listing codes ---------- */

test("an admin makes a code: 8 characters shown as XXXX-XXXX, preset saved, expires in about 7 days", async () => {
  const r = await makeCode();
  assert.equal(r.status, 200);
  assert.match(r.json.code.code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert.equal(r.json.code.roleId, "role-crew");
  assert.equal(r.json.code.permInventory, "view");
  assert.equal(r.json.code.state, "active");
  const days = (new Date(r.json.code.expiresAt) - Date.now()) / 86400000;
  assert.ok(days > 6.9 && days < 7.1, "default expiry is 7 days, got " + days);
  const row = db.tables.join_codes[0];
  assert.equal(row.venue_id, A);
  assert.equal(row.created_by, "ADMIN-1");
  assert.equal(row.code, normalizeCode(r.json.code.code));
});

test("only Employees: edit may make, list or turn off codes, or see and decide requests", async () => {
  const made = await makeCode();
  for (const [fn, method, body, qs] of [
    [joinCodes, "POST", crewPreset], [joinCodes, "GET"], [joinCodes, "DELETE", null, { id: String(made.json.code.id) }],
    [joinRequests, "GET"], [joinRequests, "POST", { id: 1, action: "approve" }]
  ]) {
    const r = await call(fn, viewer, method, body, qs);
    assert.equal(r.status, 403, method + " as view-only");
  }
  assert.equal((await call(joinCodes, sam, "GET")).status, 403, "someone on no roster");
  assert.equal((await call(joinCodes, { clientContext: {} }, "GET")).status, 401, "not logged in");
  assert.equal(db.tables.join_codes.length, 1);
});

test("code settings are validated: days 1-30, use limit 1-1000 or blank, role must be this venue's", async () => {
  for (const bad of [{ days: 0 }, { days: 31 }, { days: 2.5 }, { days: "x" }, { maxUses: 0 }, { maxUses: -1 }, { maxUses: 1001 }, { maxUses: "many" }, { roleId: "role-b" }, { roleId: "nope" }]) {
    const r = await makeCode(alice, { ...crewPreset, ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((db.tables.join_codes || []).length, 0);
  const ok = await makeCode(alice, { permInventory: "edit", days: 30, maxUses: 1000 });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.code.roleId, null, "a code with no role is allowed");
  assert.equal(ok.json.code.maxUses, 1000);
  const junk = await makeCode(alice, { permInventory: "root", permSettings: "<b>" });
  assert.equal(junk.json.code.permInventory, "none", "unknown access levels become 'none'");
  assert.equal(junk.json.code.permSettings, "none");
});

test("the list shows only this venue's live codes, with use counts and state", async () => {
  const mine = (await makeCode(alice, { ...crewPreset, maxUses: 1 })).json.code;
  const theirs = (await makeCode(bob, { permInventory: "view" })).json.code;
  const expired = (await makeCode()).json.code;
  db.tables.join_codes.find((c) => c.id === expired.id).expires_at = new Date(Date.now() - 1000).toISOString();
  const off = (await makeCode()).json.code;
  await call(joinCodes, alice, "DELETE", null, { id: String(off.id) });
  await join(sam, mine.code); // uses up the single place

  const list = (await call(joinCodes, alice, "GET")).json.codes;
  const byId = Object.fromEntries(list.map((c) => [c.id, c]));
  assert.ok(byId[mine.id] && byId[expired.id]);
  assert.equal(byId[theirs.id], undefined, "another venue's code must not be listed");
  assert.equal(byId[off.id], undefined, "turned-off codes disappear");
  assert.equal(byId[mine.id].uses, 1);
  assert.equal(byId[mine.id].state, "used_up");
  assert.equal(byId[expired.id].state, "expired");
  assert.equal(list.length, 2);
});

/* ---------- using a code ---------- */

test("using a code makes a PENDING request carrying the preset, and grants nothing yet", async () => {
  const { code } = (await makeCode()).json;
  const r = await join(sam, code.code.toLowerCase().replace("-", " "), { name: "  Sam Rivera " });
  assert.equal(r.status, 200);
  assert.equal(r.json.venueName, "Venue A");
  const [req] = pendingFor(A);
  assert.equal(req.email, "sam@new.test");
  assert.equal(req.name, "Sam Rivera");
  assert.equal(req.role_id, "role-crew");
  assert.equal(req.perm_inventory, "view");
  assert.equal(req.code_id, code.id);
  assert.equal(db.tables.employees.length, 3, "no roster row until an admin approves");
  assert.equal((await call(bootstrap, sam, "GET")).json.code, "pending");
  assert.deepEqual((await call(onboarding, sam, "GET")).json, { state: "pending", venueName: "Venue A" });
  assert.equal((await call(items, sam, "GET")).status, 403);
});

test("the request's email comes from the login, never from the request body", async () => {
  const { code } = (await makeCode()).json;
  const r = await join(sam, code.code, { email: "alice@a.test", venue_id: B, perm_settings: "edit", role_id: "x" });
  assert.equal(r.status, 200);
  const [req] = db.tables.join_requests;
  assert.equal(req.email, "sam@new.test");
  assert.equal(req.venue_id, A);
  assert.equal(req.perm_settings, "none");
  assert.equal(req.role_id, "role-crew");
});

test("a very long typed name is cut to 80 characters; no name falls back to the login's name or email", async () => {
  const { code } = (await makeCode()).json;
  await join(sam, code.code, { name: "N".repeat(500) });
  assert.equal(db.tables.join_requests[0].name.length, 80);
  await call(onboarding, sam, "POST", { action: "cancel" });
  await join(ctx("sam@new.test", { full_name: "Sam From Login" }), code.code);
  assert.equal(db.tables.join_requests[1].name, "Sam From Login");
  await call(onboarding, sam, "POST", { action: "cancel" });
  await join(ctx("sam@new.test"), code.code);
  assert.equal(db.tables.join_requests[2].name, "sam");
});

test("a wrong, expired, turned-off or used-up code gets the same answer and makes no request", async () => {
  const good = (await makeCode()).json.code;
  const expired = (await makeCode()).json.code;
  db.tables.join_codes.find((c) => c.id === expired.id).expires_at = new Date(Date.now() - 1000).toISOString();
  const off = (await makeCode()).json.code;
  await call(joinCodes, alice, "DELETE", null, { id: String(off.id) });
  const one = (await makeCode(alice, { ...crewPreset, maxUses: 1 })).json.code;
  await join(ctx("first@new.test"), one.code);
  const before = db.tables.join_requests.length;

  const answers = [];
  for (const c of ["ZZZZ-ZZZZ", "ABC", "", expired.code, off.code, one.code, null, 12345678]) {
    const r = await join(sam, c);
    assert.equal(r.status, 400, String(c));
    answers.push(r.json.error);
  }
  assert.equal(new Set(answers).size, 1, "every failure reads the same, so codes can't be probed");
  assert.equal(db.tables.join_requests.length, before);
  assert.equal((await join(sam, good.code)).status, 200, "the good code still works");
});

test("a code for a venue that has since been deleted is refused", async () => {
  const { code } = (await makeCode()).json;
  db.tables.venues.find((v) => v.id === A).deleted_at = "2026-09-01";
  assert.equal((await join(sam, code.code)).status, 400);
  assert.equal((db.tables.join_requests || []).length, 0);
});

test("use limit: pending and approved requests count, declined and cancelled ones give the place back", async () => {
  const { code } = (await makeCode(alice, { ...crewPreset, maxUses: 2 })).json;
  const p1 = ctx("p1@new.test"), p2 = ctx("p2@new.test"), p3 = ctx("p3@new.test");
  assert.equal((await join(p1, code.code)).status, 200);
  assert.equal((await join(p2, code.code)).status, 200);
  assert.equal((await join(p3, code.code)).status, 400, "limit of 2 reached");

  const r1 = db.tables.join_requests.find((r) => r.email === "p1@new.test");
  await call(joinRequests, alice, "POST", { id: r1.id, action: "decline" });
  assert.equal((await join(p3, code.code)).status, 200, "a declined request frees its place");
  assert.equal((await call(joinCodes, alice, "GET")).json.codes[0].uses, 2);

  await call(onboarding, p2, "POST", { action: "cancel" });
  assert.equal((await join(p1, code.code)).status, 200, "a cancelled request frees its place too");
});

test("two people taking the last place at the same moment: the code never goes over its limit", async () => {
  const { code } = (await makeCode(alice, { ...crewPreset, maxUses: 1 })).json;
  const realFrom = db.from;
  db.from = (t) => {
    const b = realFrom(t);
    if (t !== "join_requests") return b;
    const insert = b.insert;
    b.insert = (rows) => {
      const q = insert(rows);
      const then = q.then;
      q.then = (res, rej) => then((v) => {
        // the rival's request lands between our check and our insert finishing
        db.tables.join_requests.push({ id: 900, venue_id: A, email: "rival@new.test", status: "pending", code_id: code.id });
        return res(v);
      }, rej);
      return q;
    };
    return b;
  };
  const r = await join(sam, code.code);
  db.from = realFrom;
  assert.equal(r.status, 400);
  const mine = db.tables.join_requests.filter((x) => x.email === "sam@new.test");
  assert.equal(mine.length, 0, "our request was taken back");
  assert.equal(db.tables.join_requests.filter((x) => x.code_id === code.id).length, 1);
});

test("people who already belong somewhere can't use a code", async () => {
  const { code } = (await makeCode()).json;
  assert.equal((await join(bob, code.code)).status, 409, "on another venue's roster / owns a venue");
  assert.equal((await join(viewer, code.code)).status, 409, "already on this roster");
  assert.equal((db.tables.join_requests || []).length, 0);
});

test("a person waiting on one venue can't ask a second one, or create a venue", async () => {
  const a = (await makeCode()).json.code;
  const b = (await makeCode(bob, { permInventory: "view" })).json.code;
  assert.equal((await join(sam, a.code)).status, 200);
  assert.equal((await join(sam, b.code)).status, 409);
  assert.equal((await call(onboarding, sam, "POST", { name: "Sam's Venue" })).status, 409);
  assert.equal(pendingFor(B).length, 0);
  assert.equal(db.tables.venues.length, 2);
});

test("cancel withdraws your own request and nobody else's", async () => {
  const { code } = (await makeCode()).json;
  await join(sam, code.code);
  await join(ctx("pat@new.test"), code.code);
  assert.equal((await call(onboarding, sam, "POST", { action: "cancel", email: "pat@new.test" })).status, 200);
  assert.equal(db.tables.join_requests.find((r) => r.email === "sam@new.test").status, "cancelled");
  assert.equal(db.tables.join_requests.find((r) => r.email === "pat@new.test").status, "pending");
  assert.deepEqual((await call(onboarding, sam, "GET")).json, { state: "needs_venue" });
  assert.equal((await call(joinRequests, alice, "GET")).json.requests.length, 1);
});

/* ---------- deciding ---------- */

test("approving adds exactly the preset to this venue's roster, and their next sign-in works", async () => {
  const { code } = (await makeCode()).json;
  await join(sam, code.code, { name: "Sam Rivera" });
  const list = (await call(joinRequests, alice, "GET")).json.requests;
  assert.equal(list.length, 1);
  assert.equal(list[0].email, "sam@new.test");
  assert.equal(list[0].name, "Sam Rivera");

  const r = await call(joinRequests, alice, "POST", { id: list[0].id, action: "approve" });
  assert.equal(r.status, 200);
  const emp = db.tables.employees.find((e) => e.email === "sam@new.test");
  assert.equal(emp.venue_id, A);
  assert.equal(emp.id, "ID-1001", "numbered after the highest existing id, like the Employees page does");
  assert.equal(emp.name, "Sam Rivera");
  assert.equal(emp.role_id, "role-crew");
  assert.deepEqual([emp.perm_inventory, emp.perm_call_list, emp.perm_employees, emp.perm_settings], ["view", "view", "none", "none"]);
  assert.equal(emp.active, true);
  assert.equal(db.tables.join_requests[0].status, "approved");
  assert.equal(db.tables.join_requests[0].decided_by, "ADMIN-1");

  const boot = await call(bootstrap, sam, "GET");
  assert.equal(boot.status, 200);
  assert.equal(boot.json.me.venue_id, A);
  assert.deepEqual(boot.json.items.map((i) => i.name), ["A lamp"], "sees only Venue A's data");
  assert.deepEqual((await call(onboarding, sam, "GET")).json, { state: "member", venueName: "Venue A", replaceable: false });
  assert.equal((await call(joinCodes, sam, "GET")).status, 403, "view access doesn't make them an admin");
});

test("approving never gives more than the code promised, even if the approve call carries extras", async () => {
  const { code } = (await makeCode(alice, { permInventory: "view" })).json;
  await join(sam, code.code);
  const [req] = pendingFor(A);
  await call(joinRequests, alice, "POST", { id: req.id, action: "approve", permSettings: "edit", permEmployees: "edit", roleId: "role-crew", email: "evil@x.test" });
  const emp = db.tables.employees.find((e) => e.email === "sam@new.test");
  assert.ok(emp, "joined under the email they signed in with");
  assert.equal(db.tables.employees.some((e) => e.email === "evil@x.test"), false);
  assert.equal(emp.perm_settings, "none");
  assert.equal(emp.perm_employees, "none");
  assert.equal(emp.role_id, null);
});

test("declining sends them back to 'create your venue', and they can ask again", async () => {
  const { code } = (await makeCode()).json;
  await join(sam, code.code);
  const [req] = pendingFor(A);
  assert.equal((await call(joinRequests, alice, "POST", { id: req.id, action: "decline" })).status, 200);
  assert.equal(db.tables.join_requests[0].status, "declined");
  assert.equal(db.tables.employees.some((e) => e.email === "sam@new.test"), false);
  assert.deepEqual((await call(onboarding, sam, "GET")).json, { state: "needs_venue" });
  assert.equal((await call(joinRequests, alice, "GET")).json.requests.length, 0);
  assert.equal((await join(sam, code.code)).status, 200);
});

test("a request can be decided only once", async () => {
  const { code } = (await makeCode()).json;
  await join(sam, code.code);
  const [req] = pendingFor(A);
  assert.equal((await call(joinRequests, alice, "POST", { id: req.id, action: "approve" })).status, 200);
  assert.equal((await call(joinRequests, alice, "POST", { id: req.id, action: "approve" })).status, 404);
  assert.equal((await call(joinRequests, alice, "POST", { id: req.id, action: "decline" })).status, 404);
  assert.equal(db.tables.employees.filter((e) => e.email === "sam@new.test").length, 1);
  assert.equal(db.tables.join_requests[0].status, "approved");
});

test("bad decisions are rejected", async () => {
  const { code } = (await makeCode()).json;
  await join(sam, code.code);
  const [req] = pendingFor(A);
  for (const body of [{}, { id: req.id }, { id: req.id, action: "delete" }, { action: "approve" }, { id: "x", action: "approve" }, { id: 999, action: "approve" }]) {
    const r = await call(joinRequests, alice, "POST", body);
    assert.ok(r.status === 400 || r.status === 404, JSON.stringify(body) + " -> " + r.status);
  }
  assert.equal(pendingFor(A).length, 1);
});

test("if they were added to a roster while waiting, approving closes the request without a duplicate", async () => {
  const { code } = (await makeCode()).json;
  await join(sam, code.code);
  db.tables.employees.push({ venue_id: B, id: "ID-1000", name: "Sam", email: "sam@new.test", ...none }); // Venue B's admin added Sam directly
  const [req] = pendingFor(A);
  const r = await call(joinRequests, alice, "POST", { id: req.id, action: "approve" });
  assert.equal(r.status, 409);
  assert.equal(db.tables.employees.filter((e) => e.email === "sam@new.test").length, 1);
  assert.equal(db.tables.employees.find((e) => e.email === "sam@new.test").venue_id, B);
  assert.equal(db.tables.join_requests[0].status, "cancelled");
});

test("a role deleted after the code was made is dropped, not an error", async () => {
  const { code } = (await makeCode()).json;
  await join(sam, code.code);
  db.tables.roles = db.tables.roles.filter((r) => r.id !== "role-crew");
  const [req] = pendingFor(A);
  assert.equal((await call(joinRequests, alice, "POST", { id: req.id, action: "approve" })).status, 200);
  assert.equal(db.tables.employees.find((e) => e.email === "sam@new.test").role_id, null);
});

test("turning a code off stops new use but leaves requests already made decidable", async () => {
  const { code } = (await makeCode()).json;
  await join(sam, code.code);
  assert.equal((await call(joinCodes, alice, "DELETE", null, { id: String(code.id) })).status, 200);
  assert.equal((await join(ctx("late@new.test"), code.code)).status, 400);
  const [req] = pendingFor(A);
  assert.equal((await call(joinRequests, alice, "POST", { id: req.id, action: "approve" })).status, 200);
  assert.equal((await call(joinCodes, alice, "DELETE", null, { id: String(code.id) })).status, 404, "already off");
  assert.equal((await call(joinCodes, alice, "DELETE", null, { id: "abc" })).status, 400);
});

/* ---------- venue separation ---------- */

test("one venue's admin can't list, approve, decline or turn off another venue's codes and requests", async () => {
  const a = (await makeCode()).json.code;
  await join(sam, a.code);
  const [req] = pendingFor(A);

  assert.deepEqual((await call(joinRequests, bob, "GET")).json.requests, [], "Bob sees none of Venue A's requests");
  assert.deepEqual((await call(joinCodes, bob, "GET")).json.codes, [], "Bob sees none of Venue A's codes");
  assert.equal((await call(joinRequests, bob, "POST", { id: req.id, action: "approve" })).status, 404);
  assert.equal((await call(joinRequests, bob, "POST", { id: req.id, action: "decline" })).status, 404);
  assert.equal((await call(joinCodes, bob, "DELETE", null, { id: String(a.id) })).status, 404);

  assert.equal(pendingFor(A).length, 1, "request untouched");
  assert.equal(db.tables.join_codes[0].revoked_at, null, "code untouched");
  assert.equal(db.tables.employees.some((e) => e.email === "sam@new.test"), false);
  assert.equal(db.tables.employees.filter((e) => e.venue_id === B).length, 1);
});

test("each venue's codes and requests stay in their own venue, side by side", async () => {
  const a = (await makeCode(alice, { permInventory: "view" })).json.code;
  const b = (await makeCode(bob, { permInventory: "edit", permCallList: "edit" })).json.code;
  assert.notEqual(normalizeCode(a.code), normalizeCode(b.code));
  await join(ctx("one@new.test"), a.code);
  await join(ctx("two@new.test"), b.code);
  const aReqs = (await call(joinRequests, alice, "GET")).json.requests;
  const bReqs = (await call(joinRequests, bob, "GET")).json.requests;
  assert.deepEqual(aReqs.map((r) => r.email), ["one@new.test"]);
  assert.deepEqual(bReqs.map((r) => r.email), ["two@new.test"]);
  await call(joinRequests, alice, "POST", { id: aReqs[0].id, action: "approve" });
  await call(joinRequests, bob, "POST", { id: bReqs[0].id, action: "approve" });
  const one = db.tables.employees.find((e) => e.email === "one@new.test");
  const two = db.tables.employees.find((e) => e.email === "two@new.test");
  assert.equal(one.venue_id, A);
  assert.equal(two.venue_id, B);
  assert.equal(one.perm_inventory, "view");
  assert.equal(two.perm_call_list, "edit");
  assert.deepEqual((await call(bootstrap, ctx("one@new.test"), "GET")).json.items.map((i) => i.name), ["A lamp"]);
  assert.deepEqual((await call(bootstrap, ctx("two@new.test"), "GET")).json.items.map((i) => i.name), ["B lamp"]);
});

test("a person approved into a venue with edit access to Employees becomes that venue's admin only", async () => {
  const { code } = (await makeCode(alice, { permEmployees: "edit", permSettings: "edit" })).json;
  await join(sam, code.code);
  await call(joinRequests, alice, "POST", { id: pendingFor(A)[0].id, action: "approve" });
  assert.equal((await call(joinCodes, sam, "GET")).status, 200);
  assert.deepEqual((await call(joinCodes, sam, "GET")).json.codes.map((c) => c.id), [code.id]);
  assert.deepEqual((await call(joinCodes, bob, "GET")).json.codes, []);
});

/* ---------- pages ---------- */

test("every element id that welcome.js and requests.js look up exists in their page", () => {
  const fs = require("fs");
  const root = path.join(__dirname, "..");
  for (const [html, js] of [["welcome.html", "js/welcome.js"], ["requests.html", "js/requests.js"]]) {
    const page = fs.readFileSync(path.join(root, html), "utf8");
    const src = fs.readFileSync(path.join(root, js), "utf8");
    const used = new Set([...src.matchAll(/(?:\$|getElementById)\(\s*["']([\w-]+)["']\s*\)/g)].map((m) => m[1]));
    const missing = [...used].filter((id) => !new RegExp('id="' + id + '"').test(page));
    assert.deepEqual(missing, [], js + " uses ids missing from " + html);
    assert.ok(used.size > 5, "found the ids");
  }
});

test("the Join requests page is only offered to people who can edit Employees", () => {
  const fs = require("fs");
  const ui = fs.readFileSync(path.join(__dirname, "..", "js", "ui.js"), "utf8");
  assert.match(ui, /href: "requests\.html"[^}]*area: "employees", need: "edit"/);
  const page = fs.readFileSync(path.join(__dirname, "..", "requests.html"), "utf8");
  assert.match(page, /data-area="employees" data-need="edit"/);
});

/* ---------- replacing a venue made by mistake ---------- */

const oops = ctx("oops@new.test");
const venueOf = (email) => db.tables.venues.find((v) => v.owner_email === email);
const swapJoin = (who, code) => call(onboarding, who, "POST", { action: "join", code, replaceVenue: true });
async function accidentalVenue() {
  const made = await call(onboarding, oops, "POST", { name: "Oops Theater", subtitle: "x" });
  assert.equal(made.status, 200);
  return made.json.venueId;
}

test("a venue made by mistake is reported as replaceable; one with data or people is not", async () => {
  const id = await accidentalVenue();
  assert.deepEqual((await call(onboarding, oops, "GET")).json, { state: "member", venueName: "Oops Theater", replaceable: true });
  db.tables.items.push({ venue_id: id, id: "LX-0001", name: "Lamp", status: "ok", location: "x", restricted_to: [], holder: null });
  assert.equal((await call(onboarding, oops, "GET")).json.replaceable, false);
});

test("joining with a code can replace the venue you just created by mistake", async () => {
  const id = await accidentalVenue();
  const { code } = (await makeCode()).json;
  const r = await swapJoin(oops, code.code);
  assert.equal(r.status, 200);
  assert.equal(r.json.venueName, "Venue A");
  assert.equal(db.tables.venues.some((v) => v.id === id), false, "the mistaken venue is gone");
  assert.equal(db.tables.employees.some((e) => e.venue_id === id), false);
  assert.equal(db.tables.venues.length, 2, "the other venues are untouched");
  assert.equal(db.tables.employees.length, 3, "only the mistaken roster row was removed");
  assert.deepEqual((await call(onboarding, oops, "GET")).json, { state: "pending", venueName: "Venue A" });
  assert.equal(pendingFor(A)[0].email, "oops@new.test");

  await call(joinRequests, alice, "POST", { id: pendingFor(A)[0].id, action: "approve" });
  const boot = await call(bootstrap, oops, "GET");
  assert.equal(boot.status, 200);
  assert.equal(boot.json.me.venue_id, A);
});

test("their old venue's own codes go with it, and nobody can still use them", async () => {
  await accidentalVenue();
  const own = (await makeCode(oops, { permInventory: "view" })).json.code;
  const { code } = (await makeCode()).json;
  assert.equal((await swapJoin(oops, code.code)).status, 200);
  assert.equal(db.tables.join_codes.some((c) => c.venue_id === venueOf("oops@new.test") ), false);
  assert.equal((await join(sam, own.code)).status, 400);
});

test("without replaceVenue: true nothing is deleted", async () => {
  const id = await accidentalVenue();
  const { code } = (await makeCode()).json;
  const r = await call(onboarding, oops, "POST", { action: "join", code: code.code });
  assert.equal(r.status, 409);
  assert.ok(db.tables.venues.some((v) => v.id === id));
  assert.equal(pendingFor(A).length, 0);
});

test("a bad, expired or used-up code never costs you your venue", async () => {
  const id = await accidentalVenue();
  const expired = (await makeCode()).json.code;
  db.tables.join_codes.find((c) => c.id === expired.id).expires_at = new Date(Date.now() - 1000).toISOString();
  const one = (await makeCode(alice, { ...crewPreset, maxUses: 1 })).json.code;
  await join(ctx("first@new.test"), one.code);
  for (const c of ["ZZZZ-ZZZZ", "", expired.code, one.code]) {
    assert.equal((await swapJoin(oops, c)).status, 400, String(c));
  }
  assert.ok(db.tables.venues.some((v) => v.id === id));
  assert.ok(db.tables.employees.some((e) => e.venue_id === id && e.email === "oops@new.test"));
});

test("a venue with data, other people, waiting requests, or that you don't own is never replaced", async () => {
  const { code } = (await makeCode()).json;

  // someone else's venue (a member who isn't the owner) - and Alice owns Venue A, which has data
  assert.equal((await swapJoin(viewer, code.code)).status, 409, "member, not owner");
  assert.equal((await swapJoin(alice, code.code)).status, 409, "owner, but the venue has data and people");
  assert.equal((await swapJoin(bob, code.code)).status, 409);
  assert.equal(db.tables.venues.length, 2);

  // items
  let id = await accidentalVenue();
  db.tables.items.push({ venue_id: id, id: "LX-0001", name: "Lamp", status: "ok", location: "x", restricted_to: [], holder: null });
  assert.equal((await swapJoin(oops, code.code)).status, 409, "has an item");
  db.tables.items = db.tables.items.filter((i) => i.venue_id !== id);

  // a role
  db.tables.roles.push({ venue_id: id, id: "role-x", name: "Crew" });
  assert.equal((await swapJoin(oops, code.code)).status, 409, "has a role");
  db.tables.roles = db.tables.roles.filter((r) => r.venue_id !== id);

  // another person on the roster
  db.tables.employees.push({ venue_id: id, id: "ID-1000", name: "Pal", email: "pal@new.test", ...none });
  assert.equal((await swapJoin(oops, code.code)).status, 409, "has another person");
  db.tables.employees = db.tables.employees.filter((e) => e.email !== "pal@new.test");

  // someone waiting to join it
  const mine = (await makeCode(oops, { permInventory: "view" })).json.code;
  await join(sam, mine.code);
  assert.equal((await swapJoin(oops, code.code)).status, 409, "someone is waiting");

  assert.ok(db.tables.venues.some((v) => v.id === id), "still here after every refusal");
  assert.equal(pendingFor(A).length, 0, "no request was left behind in Venue A");
});

test("if the venue can't be removed, nothing changes: roster row back, request withdrawn", async () => {
  const id = await accidentalVenue();
  const { code } = (await makeCode()).json;
  const real = db.from;
  db.from = (t) => {
    const api = real(t);
    if (t !== "venues") return api;
    return Object.assign({}, api, { delete: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: { code: "XX000", message: "boom" } }) }) }) });
  };
  const r = await swapJoin(oops, code.code);
  db.from = real;
  assert.equal(r.status, 500);
  assert.ok(db.tables.venues.some((v) => v.id === id));
  assert.ok(db.tables.employees.some((e) => e.venue_id === id && e.email === "oops@new.test"), "roster row restored");
  assert.equal(pendingFor(A).length, 0, "request withdrawn");
  assert.deepEqual((await call(onboarding, oops, "GET")).json.state, "member");
});

test("if they are declined after swapping, they can create a venue again", async () => {
  await accidentalVenue();
  const { code } = (await makeCode()).json;
  await swapJoin(oops, code.code);
  await call(joinRequests, alice, "POST", { id: pendingFor(A)[0].id, action: "decline" });
  assert.deepEqual((await call(onboarding, oops, "GET")).json, { state: "needs_venue" });
  assert.equal((await call(onboarding, oops, "POST", { name: "Second try" })).status, 200);
});

test("the welcome page and Settings carry what the swap needs", () => {
  const fs = require("fs");
  const root = path.join(__dirname, "..");
  assert.match(fs.readFileSync(path.join(root, "settings.html"), "utf8"), /welcome\.html\?join=1/);
  assert.match(fs.readFileSync(path.join(root, "js", "welcome.js"), "utf8"), /replaceVenue/);
});

test("an empty venue you don't own (you were added to it) is never deleted by your joining elsewhere", async () => {
  db.tables.venues.push({ id: "venue-c", name: "Empty C", subtitle: "", logo: null, owner_email: "boss@c.test", deleted_at: null, created_at: "2026-03-01" });
  db.tables.employees.push({ venue_id: "venue-c", id: "ID-1000", name: "Temp", email: "temp@c.test", ...none });
  const { code } = (await makeCode()).json;
  const r = await swapJoin(ctx("temp@c.test"), code.code);
  assert.equal(r.status, 409);
  assert.ok(db.tables.venues.some((v) => v.id === "venue-c"));
  assert.ok(db.tables.employees.some((e) => e.email === "temp@c.test" && e.venue_id === "venue-c"));
  assert.equal(pendingFor(A).length, 0);
});
