/**
 * Piece 3: sign-up onboarding.
 *  - someone on no roster is told to create a venue (or that they're pending), never auto-admin
 *  - creating a venue makes them owner + admin of a brand-new, separate venue
 *  - one venue per email, and a failed creation never leaves a half-made venue behind
 *  - identity-users can't be used to take over somebody else's login
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
const identityUsers = require(path.join(FN, "identity-users")).handler;
const items = require(path.join(FN, "items")).handler;

const A = "venue-a", B = "venue-b";
const full = { perm_inventory: "edit", perm_call_list: "edit", perm_employees: "edit", perm_settings: "edit", active: true };

function seed() {
  return {
    venues: [
      { id: A, name: "Venue A", subtitle: "", logo: null, owner_email: "alice@a.test", deleted_at: null, created_at: "2026-01-01" },
      { id: B, name: "Venue B", subtitle: "", logo: null, owner_email: "bob@b.test", deleted_at: null, created_at: "2026-02-01" }
    ],
    employees: [
      { venue_id: A, id: "ADMIN-1", name: "Alice-A", email: "alice@a.test", ...full },
      { venue_id: B, id: "ADMIN-1", name: "Bob-B", email: "bob@b.test", ...full }
    ],
    roles: [{ venue_id: A, id: "role-1", name: "Crew" }],
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
const venuesNow = () => db.tables.venues.length;

test.beforeEach(() => { db = makeFake(seed()); });

/* ---------- who are you? ---------- */

test("a stranger is no longer made an admin: bootstrap says they need a venue", async () => {
  const r = await call(bootstrap, ctx("stranger@new.test"), "GET");
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "needs_onboarding");
  assert.equal(db.tables.employees.length, 2, "no employee row may be created by just logging in");
  assert.equal(venuesNow(), 2);
});

test("ADMIN_EMAILS no longer grants anything", async () => {
  process.env.ADMIN_EMAILS = "stranger@new.test";
  try {
    const r = await call(bootstrap, ctx("stranger@new.test"), "GET");
    assert.equal(r.status, 403);
    assert.equal(db.tables.employees.length, 2);
  } finally { delete process.env.ADMIN_EMAILS; }
});

test("onboarding GET: member, needs_venue, pending", async () => {
  assert.deepEqual(await call(onboarding, ctx("alice@a.test"), "GET").then((r) => r.json), { state: "member", venueName: "Venue A" });
  assert.deepEqual(await call(onboarding, ctx("stranger@new.test"), "GET").then((r) => r.json), { state: "needs_venue" });
  db.tables.join_requests = [{ id: 1, venue_id: A, email: "pat@new.test", status: "pending" }];
  assert.deepEqual(await call(onboarding, ctx("pat@new.test"), "GET").then((r) => r.json), { state: "pending" });
  const b = await call(bootstrap, ctx("pat@new.test"), "GET");
  assert.equal(b.status, 403);
  assert.equal(b.json.code, "pending");
});

test("a request that was declined or cancelled is not 'pending'", async () => {
  db.tables.join_requests = [
    { id: 1, venue_id: A, email: "dee@new.test", status: "declined" },
    { id: 2, venue_id: A, email: "cam@new.test", status: "cancelled" }
  ];
  for (const e of ["dee@new.test", "cam@new.test"]) {
    assert.equal((await call(onboarding, ctx(e), "GET")).json.state, "needs_venue");
  }
});

test("emails are matched case-insensitively", async () => {
  assert.equal((await call(onboarding, ctx("ALICE@A.test"), "GET")).json.state, "member");
});

test("not logged in -> 401", async () => {
  assert.equal((await call(onboarding, {}, "GET")).status, 401);
  assert.equal((await call(onboarding, {}, "POST", { name: "X" })).status, 401);
});

/* ---------- creating a venue ---------- */

test("create venue: caller becomes owner + admin of a new, separate venue", async () => {
  const who = ctx("new@owner.test", { full_name: "Nia Owner" });
  const made = await call(onboarding, who, "POST", { name: "  Lincoln High  ", subtitle: "Crew" });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const v = db.tables.venues.find((x) => x.id === made.json.venueId);
  assert.ok(v && ![A, B].includes(v.id));
  assert.equal(v.name, "Lincoln High");
  assert.equal(v.subtitle, "Crew");
  assert.equal(v.logo, null);
  assert.equal(v.owner_email, "new@owner.test");
  const mine = db.tables.employees.filter((e) => e.venue_id === v.id);
  assert.equal(mine.length, 1);
  assert.deepEqual([mine[0].id, mine[0].name, mine[0].email], ["ADMIN-1", "Nia Owner", "new@owner.test"]);
  for (const k of ["perm_inventory", "perm_call_list", "perm_employees", "perm_settings"]) assert.equal(mine[0][k], "edit");
  assert.equal(mine[0].active, true);
});

test("after creating, bootstrap shows only the new venue: none of A's or B's data", async () => {
  const who = ctx("new@owner.test");
  await call(onboarding, who, "POST", { name: "Fresh Venue" });
  const r = await call(bootstrap, who, "GET");
  assert.equal(r.status, 200);
  assert.equal(r.json.branding.appName, "Fresh Venue");
  assert.equal(r.json.me.id, "ADMIN-1");
  assert.deepEqual(r.json.items, []);
  assert.deepEqual(r.json.roles, []);
  assert.deepEqual(r.json.employees.map((e) => e.email), ["new@owner.test"]);
  assert.ok(!JSON.stringify(r.json).includes("lamp"));
  // and they can't touch the id both old venues use
  const del = await call(items, who, "DELETE", null, { id: "LX-0001" });
  assert.equal(del.status, 404);
  assert.equal(db.tables.items.length, 2);
});

test("two sign-ups get two separate venues, both with ADMIN-1, without colliding", async () => {
  const one = await call(onboarding, ctx("one@x.test"), "POST", { name: "One" });
  const two = await call(onboarding, ctx("two@x.test"), "POST", { name: "Two" });
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  assert.notEqual(one.json.venueId, two.json.venueId);
  const names = (email) => call(bootstrap, ctx(email), "GET").then((r) => r.json.branding.appName);
  assert.equal(await names("one@x.test"), "One");
  assert.equal(await names("two@x.test"), "Two");
  assert.equal(venuesNow(), 4);
});

test("optional logo is stored; a bad logo is refused and creates nothing", async () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const ok = await call(onboarding, ctx("logo@x.test"), "POST", { name: "Logo", logo: png });
  assert.equal(ok.status, 200);
  assert.equal(db.tables.venues.find((v) => v.id === ok.json.venueId).logo, png);
  const before = venuesNow();
  for (const logo of ["javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64," + "A".repeat(400001)]) {
    const bad = await call(onboarding, ctx("bad@x.test"), "POST", { name: "Bad", logo });
    assert.equal(bad.status, 400, logo.slice(0, 30));
  }
  assert.equal(venuesNow(), before);
});

test("name is required, trimmed and length-limited; subtitle is limited", async () => {
  const who = ctx("v@x.test");
  for (const body of [{}, { name: "   " }, { name: "x".repeat(61) }, { name: "ok", subtitle: "x".repeat(41) }]) {
    assert.equal((await call(onboarding, who, "POST", body)).status, 400, JSON.stringify(body).slice(0, 40));
  }
  assert.equal(venuesNow(), 2);
});

/* ---------- one venue per email ---------- */

test("someone already on a roster can't create a second venue", async () => {
  for (const email of ["alice@a.test", "bob@b.test"]) {
    const r = await call(onboarding, ctx(email), "POST", { name: "Another" });
    assert.equal(r.status, 409);
  }
  assert.equal(venuesNow(), 2);
});

test("the same person can't create two venues (second attempt is a 409)", async () => {
  const who = ctx("twice@x.test");
  assert.equal((await call(onboarding, who, "POST", { name: "First" })).status, 200);
  assert.equal((await call(onboarding, who, "POST", { name: "Second" })).status, 409);
  assert.equal(venuesNow(), 3);
});

test("an owner whose roster row is somehow gone still can't make another venue", async () => {
  db.tables.employees = db.tables.employees.filter((e) => e.email !== "alice@a.test");
  const r = await call(onboarding, ctx("alice@a.test"), "POST", { name: "Sneaky" });
  assert.equal(r.status, 409);
  assert.equal(venuesNow(), 2);
});

test("someone waiting on a join request can't create a venue", async () => {
  db.tables.join_requests = [{ id: 1, venue_id: A, email: "pat@new.test", status: "pending" }];
  const r = await call(onboarding, ctx("pat@new.test"), "POST", { name: "Mine" });
  assert.equal(r.status, 409);
  assert.equal(venuesNow(), 2);
});

test("if the admin row can't be written, the new venue is removed again (and only that one)", async () => {
  const real = db.from;
  db.from = (t) => {
    const api = real(t);
    if (t !== "employees") return api;
    return Object.assign({}, api, { insert: () => Promise.resolve({ data: null, error: { code: "XX000", message: "boom" } }) });
  };
  const r = await call(onboarding, ctx("fail@x.test"), "POST", { name: "Doomed" });
  assert.equal(r.status, 500);
  assert.equal(venuesNow(), 2, "half-made venue left behind");
  assert.deepEqual(db.tables.venues.map((v) => v.id).sort(), [A, B]);
});

test("losing a race for the same email (employee insert hits the unique key) removes the new venue", async () => {
  const real = db.from;
  db.from = (t) => {
    const api = real(t);
    if (t !== "employees") return api;
    return Object.assign({}, api, { insert: () => Promise.resolve({ data: null, error: { code: "23505", message: "duplicate" } }) });
  };
  const r = await call(onboarding, ctx("race@x.test"), "POST", { name: "Racer" });
  assert.equal(r.status, 409);
  assert.equal(venuesNow(), 2);
});

/* ---------- identity-users: no account takeover ---------- */

function fakeIdentity(users) {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    const method = (init && init.method) || "GET";
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url, body });
    const json = (o, status) => ({ ok: !status || status < 400, status: status || 200, text: async () => JSON.stringify(o) });
    if (method === "GET") return json({ users });
    if (method === "POST") return json({ id: "new-user", email: body.email });
    return json({ id: url.split("/").pop() });
  };
  return { calls, restore: () => { global.fetch = realFetch; } };
}
const idCtx = (email) => ({ clientContext: { user: { email }, identity: { url: "https://id.test", token: "t" } } });
const setPw = (who, email) => call(identityUsers, who, "POST", { email, password: "longenough1" });
const writes = (calls) => calls.filter((c) => c.method !== "GET");

test("takeover: an admin can't reset the password of a login the person made for themselves", async () => {
  // Venue B is not the original venue, and 'sam' signed up on their own (no stamp).
  db.tables.employees.push({ venue_id: B, id: "EMP-5", name: "Sam", email: "sam@x.test", ...full, perm_employees: "none" });
  const f = fakeIdentity([{ id: "u-sam", email: "sam@x.test", app_metadata: {} }]);
  try {
    const r = await setPw(idCtx("bob@b.test"), "sam@x.test");
    assert.equal(r.status, 409);
    assert.equal(writes(f.calls).length, 0, "must not change the password");
  } finally { f.restore(); }
});

test("takeover: a login stamped by a different venue can't be reset either", async () => {
  db.tables.employees.push({ venue_id: B, id: "EMP-5", name: "Sam", email: "sam@x.test", ...full });
  const f = fakeIdentity([{ id: "u-sam", email: "sam@x.test", app_metadata: { provisioned_by: A } }]);
  try {
    const r = await setPw(idCtx("bob@b.test"), "sam@x.test");
    assert.equal(r.status, 409);
    assert.equal(writes(f.calls).length, 0);
  } finally { f.restore(); }
});

test("an admin can reset a login their own venue created", async () => {
  db.tables.employees.push({ venue_id: B, id: "EMP-5", name: "Sam", email: "sam@x.test", ...full });
  const f = fakeIdentity([{ id: "u-sam", email: "sam@x.test", app_metadata: { provisioned_by: B } }]);
  try {
    const r = await setPw(idCtx("bob@b.test"), "sam@x.test");
    assert.equal(r.status, 200);
    assert.equal(writes(f.calls).length, 1);
    assert.equal(writes(f.calls)[0].method, "PUT");
  } finally { f.restore(); }
});

test("logins from before multi-venue (no stamp) can be reset only by the original venue", async () => {
  db.tables.employees.push({ venue_id: A, id: "EMP-5", name: "Old", email: "old@x.test", ...full });
  db.tables.employees.push({ venue_id: B, id: "EMP-6", name: "Old2", email: "old2@x.test", ...full });
  const f = fakeIdentity([
    { id: "u-old", email: "old@x.test", app_metadata: {} },
    { id: "u-old2", email: "old2@x.test" }
  ]);
  try {
    assert.equal((await setPw(idCtx("alice@a.test"), "old@x.test")).status, 200); // A is the earliest venue
    assert.equal((await setPw(idCtx("bob@b.test"), "old2@x.test")).status, 409);
    assert.equal(writes(f.calls).length, 1);
  } finally { f.restore(); }
});

test("a brand-new login is stamped with the venue that created it", async () => {
  db.tables.employees.push({ venue_id: B, id: "EMP-7", name: "Newbie", email: "newbie@x.test", ...full });
  const f = fakeIdentity([]);
  try {
    const r = await setPw(idCtx("bob@b.test"), "newbie@x.test");
    assert.equal(r.status, 200);
    assert.equal(r.json.created, true);
    assert.deepEqual(writes(f.calls)[0].body.app_metadata, { provisioned_by: B });
  } finally { f.restore(); }
});

test("a venue created through onboarding is not the 'original' venue", async () => {
  const who = ctx("owner@new.test");
  const made = await call(onboarding, who, "POST", { name: "Newcomer" });
  db.tables.employees.push({ venue_id: made.json.venueId, id: "EMP-1", name: "Sam", email: "sam@x.test", ...full });
  const f = fakeIdentity([{ id: "u-sam", email: "sam@x.test", app_metadata: {} }]);
  try {
    const r = await setPw(idCtx("owner@new.test"), "sam@x.test");
    assert.equal(r.status, 409);
    assert.equal(writes(f.calls).length, 0);
  } finally { f.restore(); }
});
