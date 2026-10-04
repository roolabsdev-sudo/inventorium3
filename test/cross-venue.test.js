/**
 * Cross-venue test: two venues (A and B) that deliberately reuse the same ids
 * ("ADMIN-1", "LX-0001", "role-1", ...) and the same names, then check that a
 * member of A can never read, change or delete anything of B's.
 *
 * Run:  npm test      (or: node --test test/*.test.js)
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeFake } = require("./fake-supabase");

const FN = path.join(__dirname, "..", "netlify", "functions");
const auth = require(path.join(FN, "_shared", "auth"));
let db; // the fake database for the current test
auth.getSupabaseClient = () => db; // handlers pick this up when required below

const bootstrap = require(path.join(FN, "bootstrap")).handler;
const items = require(path.join(FN, "items")).handler;
const callList = require(path.join(FN, "call-list")).handler;
const employees = require(path.join(FN, "employees")).handler;
const settings = require(path.join(FN, "settings")).handler;
const branding = require(path.join(FN, "branding")).handler;
const identityUsers = require(path.join(FN, "identity-users")).handler;
const importLegacy = require(path.join(FN, "import-legacy")).handler;

const A = "venue-a", B = "venue-b";
const full = { perm_inventory: "edit", perm_call_list: "edit", perm_employees: "edit", perm_settings: "edit", active: true };
const viewOnly = { perm_inventory: "view", perm_call_list: "view", perm_employees: "none", perm_settings: "none", active: true };

function seed() {
  return {
    venues: [
      { id: A, name: "Venue A", subtitle: "", logo: null, owner_email: "alice@a.test", deleted_at: null, created_at: "2026-01-01" },
      { id: B, name: "Venue B", subtitle: "", logo: null, owner_email: "bob@b.test", deleted_at: null, created_at: "2026-02-01" }
    ],
    employees: [
      { venue_id: A, id: "ADMIN-1", name: "Alice-A", email: "alice@a.test", role_id: "role-1", ...full },
      { venue_id: A, id: "EMP-1", name: "Ann-A", email: "ann@a.test", role_id: "role-1", ...viewOnly },
      { venue_id: B, id: "ADMIN-1", name: "Bob-B", email: "bob@b.test", role_id: "role-1", ...full },
      { venue_id: B, id: "EMP-1", name: "Beth-B", email: "beth@b.test", role_id: "role-1", ...viewOnly },
      { venue_id: B, id: "EMP-9", name: "Bill-B", email: "bill@b.test", role_id: "role-9", ...viewOnly }
    ],
    roles: [
      { venue_id: A, id: "role-1", name: "Crew" },
      { venue_id: B, id: "role-1", name: "Crew" },
      { venue_id: B, id: "role-9", name: "B-only role" }
    ],
    locations: [
      { venue_id: A, id: "loc-1", name: "Booth" },
      { venue_id: B, id: "loc-1", name: "Booth" }
    ],
    items: [
      { venue_id: A, id: "LX-0001", name: "A lamp", status: "ok", location: "Booth", restricted_to: ["role-1"], holder: null },
      { venue_id: B, id: "LX-0001", name: "B lamp", status: "ok", location: "Booth", restricted_to: ["role-1"], holder: null },
      { venue_id: B, id: "LX-0002", name: "B secret cable", status: "ok", location: "Booth", restricted_to: [], holder: null }
    ],
    shows: [
      { venue_id: A, id: "show-1", name: "A show" },
      { venue_id: B, id: "show-1", name: "B show" }
    ],
    show_roles: [
      { venue_id: A, id: "sr-1", name: "Stage Manager" },
      { venue_id: B, id: "sr-1", name: "Stage Manager" }
    ],
    call_list: [
      { venue_id: A, id: "call-1", show_id: "show-1", emp_id: "ADMIN-1", show_role_id: "sr-1", comm: false },
      { venue_id: B, id: "call-1", show_id: "show-1", emp_id: "ADMIN-1", show_role_id: "sr-1", comm: false },
      { venue_id: B, id: "call-2", show_id: "show-1", emp_id: "EMP-9", show_role_id: null, comm: false }
    ],
    activity_log: [
      { venue_id: A, id: "log-1", ts: "2026-03-01T00:00:00Z", type: "add", item_id: "LX-0001", item_name: "A lamp" },
      { venue_id: B, id: "log-1", ts: "2026-03-01T00:00:00Z", type: "add", item_id: "LX-0001", item_name: "B lamp" }
    ]
  };
}

const ctx = (email) => ({ clientContext: { user: { email } } });
const asA = ctx("alice@a.test");
const asAview = ctx("ann@a.test");
const asB = ctx("bob@b.test");
const call = (fn, who, method, { qs, body } = {}) =>
  fn({ httpMethod: method, queryStringParameters: qs || {}, body: body ? JSON.stringify(body) : undefined }, who).then((r) => ({ status: r.statusCode, json: JSON.parse(r.body) }));
const rows = (t, venue) => db.tables[t].filter((r) => r.venue_id === venue);
const row = (t, venue, id) => db.tables[t].find((r) => r.venue_id === venue && r.id === id);

test.beforeEach(() => { db = makeFake(seed()); });

/* ---------- reads ---------- */

test("bootstrap returns only the caller's venue (both directions)", async () => {
  for (const [who, mine, theirs] of [[asA, "A", "B"], [asB, "B", "A"]]) {
    const { status, json } = await call(bootstrap, who, "GET");
    assert.equal(status, 200);
    const text = JSON.stringify(json);
    assert.ok(!text.includes("-" + theirs) && !text.includes(theirs + " "), "leaked venue " + theirs + ": " + text);
    for (const key of ["items", "log", "callList", "employees", "roles", "locations", "showRoles", "shows"]) {
      assert.ok(json[key].length > 0, key + " should have rows for " + mine);
      json[key].forEach((r) => assert.equal(r.venue_id, mine === "A" ? A : B, key + " row from the wrong venue"));
    }
    assert.equal(json.branding.appName, "Venue " + mine);
  }
});

test("a view-only member's directory only lists their own venue", async () => {
  const { json } = await call(bootstrap, asAview, "GET");
  assert.deepEqual(json.employees.map((e) => e.name).sort(), ["Alice-A", "Ann-A"]);
  assert.equal(json.me.venue_id, A);
});

test("items and call-list GET are venue-scoped", async () => {
  const i = await call(items, asA, "GET");
  assert.deepEqual(i.json.items.map((x) => x.name), ["A lamp"]);
  const c = await call(callList, asA, "GET");
  assert.deepEqual(c.json.callList.map((x) => x.venue_id), [A]);
});

/* ---------- writes ---------- */

test("deleting an item id that only exists in B does nothing for A", async () => {
  const r = await call(items, asA, "DELETE", { qs: { id: "LX-0002" } });
  assert.equal(r.status, 404);
  assert.ok(row("items", B, "LX-0002"));
});

test("deleting a shared id removes only the caller's own row", async () => {
  const r = await call(items, asA, "DELETE", { qs: { id: "LX-0001" } });
  assert.equal(r.status, 200);
  assert.equal(row("items", A, "LX-0001"), undefined);
  assert.equal(row("items", B, "LX-0001").name, "B lamp");
});

test("saving an item with B's id edits A's copy, never B's; venueId in the body is ignored", async () => {
  await call(items, asA, "POST", { body: { id: "LX-0001", name: "A lamp renamed" } });
  assert.equal(row("items", A, "LX-0001").name, "A lamp renamed");
  assert.equal(row("items", B, "LX-0001").name, "B lamp");
  const n = await call(items, asA, "POST", { body: { id: "LX-0099", name: "New", venue_id: B, venueId: B } });
  assert.equal(n.status, 200);
  assert.ok(row("items", A, "LX-0099"));
  assert.equal(row("items", B, "LX-0099"), undefined);
});

test("checkout can't reach B's items or B's people", async () => {
  const a = await call(items, asA, "POST", { qs: { action: "checkout" }, body: { itemId: "LX-0002", empId: "ADMIN-1" } });
  assert.equal(a.status, 404);
  const b = await call(items, asA, "POST", { qs: { action: "checkout" }, body: { itemId: "LX-0001", empId: "EMP-9" } });
  assert.equal(b.status, 404);
  assert.equal(row("items", B, "LX-0002").status, "ok");
});

test("settings: renaming a location only touches this venue's items", async () => {
  const r = await call(settings, asA, "POST", { qs: { resource: "locations" }, body: { id: "loc-1", name: "Booth 2" } });
  assert.equal(r.status, 200);
  assert.equal(row("items", A, "LX-0001").location, "Booth 2");
  assert.equal(row("items", B, "LX-0001").location, "Booth");
  assert.equal(row("locations", B, "loc-1").name, "Booth");
});

test("settings: the same role/location name is allowed in both venues, not twice in one", async () => {
  const ok = await call(settings, asA, "POST", { qs: { resource: "roles" }, body: { id: "role-2", name: "B-only role" } });
  assert.equal(ok.status, 200); // B has this name; A may too
  const dup = await call(settings, asA, "POST", { qs: { resource: "roles" }, body: { id: "role-3", name: "Crew" } });
  assert.equal(dup.status, 409);
});

test("settings: deleting a role cleans only this venue's items and can't delete B's roles", async () => {
  await call(employees, asA, "POST", { body: { id: "EMP-1", name: "Ann-A", email: "ann@a.test", roleId: null, permInventory: "view" } });
  await call(employees, asA, "POST", { body: { id: "ADMIN-1", name: "Alice-A", email: "alice@a.test", roleId: null, permInventory: "edit", permCallList: "edit", permSettings: "edit" } });
  const r = await call(settings, asA, "DELETE", { qs: { resource: "roles", id: "role-1" } });
  assert.equal(r.status, 200);
  assert.deepEqual(row("items", A, "LX-0001").restricted_to, []);
  assert.deepEqual(row("items", B, "LX-0001").restricted_to, ["role-1"]);
  assert.ok(row("roles", B, "role-1"));
  await call(settings, asA, "DELETE", { qs: { resource: "roles", id: "role-9" } });
  assert.ok(row("roles", B, "role-9"));
});

test("employees: can't delete B's people; a shared id like ADMIN-1 creates A's own row", async () => {
  const d = await call(employees, asA, "DELETE", { qs: { id: "EMP-9" } });
  assert.equal(d.status, 404);
  assert.ok(row("employees", B, "EMP-9"));
  const p = await call(employees, asA, "POST", { body: { id: "EMP-9", name: "A's own EMP-9", email: "new@a.test", permInventory: "view" } });
  assert.equal(p.status, 200);
  assert.equal(row("employees", B, "EMP-9").name, "Bill-B");
  assert.equal(row("employees", A, "EMP-9").name, "A's own EMP-9");
});

test("employees: using B's email is refused without revealing who it is", async () => {
  const p = await call(employees, asA, "POST", { body: { id: "EMP-5", name: "X", email: "bill@b.test" } });
  assert.equal(p.status, 409);
  assert.ok(!/Bill/.test(JSON.stringify(p.json)), "leaked a name from another venue");
  const same = await call(employees, asA, "POST", { body: { id: "EMP-6", name: "Y", email: "ann@a.test" } });
  assert.equal(same.status, 409);
  assert.ok(/Ann-A/.test(same.json.error)); // names from your own venue are fine
});

test("employees: a role from another venue is dropped", async () => {
  await call(employees, asA, "POST", { body: { id: "EMP-7", name: "Z", email: "z@a.test", roleId: "role-9" } });
  assert.equal(row("employees", A, "EMP-7").role_id, null);
});

test("identity-users: A's admin can't set a login for someone on B's roster", async () => {
  const r = await call(identityUsers, asA, "POST", { body: { email: "bill@b.test", password: "longenough1" } });
  assert.equal(r.status, 404);
});

test("call list: can't edit, link to, or delete B's entries", async () => {
  const put = await call(callList, asA, "PUT", { body: { id: "call-2", comm: true } });
  assert.equal(put.status, 404);
  assert.equal(row("call_list", B, "call-2").comm, false);
  const del = await call(callList, asA, "DELETE", { qs: { id: "call-2" } });
  assert.equal(del.status, 200);
  assert.ok(row("call_list", B, "call-2"));
  const add = await call(callList, asA, "POST", { body: { showId: "show-1", empId: "EMP-9" } }); // EMP-9 exists only in B
  assert.equal(add.status, 400);
});

test("branding: saved to the caller's venue only", async () => {
  const r = await call(branding, asA, "POST", { body: { appName: "Renamed A", appSubtitle: "Sub" } });
  assert.equal(r.status, 200);
  assert.equal(db.tables.venues.find((v) => v.id === A).name, "Renamed A");
  assert.equal(db.tables.venues.find((v) => v.id === B).name, "Venue B");
  const pub = await call(branding, {}, "GET");
  assert.equal(pub.json.appName, "Inventorium"); // sign-in page: generic placeholder
});

test("legacy import lands in the caller's venue and never touches B", async () => {
  const r = await call(importLegacy, asA, "POST", { body: {
    roles: [{ id: "role-9", name: "Imported" }],
    items: [{ id: "LX-0002", name: "Imported cable" }]
  } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(row("items", A, "LX-0002").name, "Imported cable");
  assert.equal(row("items", B, "LX-0002").name, "B secret cable");
  assert.equal(row("roles", B, "role-9").name, "B-only role");
});

/* ---------- guard rail ---------- */

test("no function reads or writes a data table with the raw client", () => {
  const allowed = { "branding.js": ["venues"], "bootstrap.js": ["venues"] };
  const offenders = [];
  for (const file of fs.readdirSync(FN).filter((f) => f.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(FN, file), "utf8");
    for (const m of src.matchAll(/supabase\s*\.from\(\s*["'](\w+)["']/g)) {
      if (!(allowed[file] || []).includes(m[1])) offenders.push(file + " -> " + m[1]);
    }
  }
  assert.deepEqual(offenders, []);
});
