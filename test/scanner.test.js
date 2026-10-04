/**
 * Scanner codes: turn a device into a scan-only scanner.
 *  - only an admin (Employees: edit) makes codes, lists them, turns them off or signs devices out
 *  - a valid code gives the device a token; the database keeps only its hash
 *  - bad / expired / turned-off / used-up / deleted-venue codes are indistinguishable to the person typing them
 *  - a scanner device can check out, check in and use up stock, under the same rules as a person; nothing else
 *  - no other function accepts a scanner token, and a scanner can never touch another venue
 *  - a device stops working the moment it signs out or an admin removes it
 *
 * Run:  npm test
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { makeFake } = require("./fake-supabase");

const FN = path.join(__dirname, "..", "netlify", "functions");
const auth = require(path.join(FN, "_shared", "auth"));
let db;
auth.getSupabaseClient = () => db;

const scannerCodes = require(path.join(FN, "scanner-codes")).handler;
const scannerSignin = require(path.join(FN, "scanner-signin")).handler;
const scanner = require(path.join(FN, "scanner")).handler;
const bootstrap = require(path.join(FN, "bootstrap")).handler;
const items = require(path.join(FN, "items")).handler;
const employees = require(path.join(FN, "employees")).handler;
const settings = require(path.join(FN, "settings")).handler;
const joinCodes = require(path.join(FN, "join-codes")).handler;
const joinRequests = require(path.join(FN, "join-requests")).handler;
const callList = require(path.join(FN, "call-list")).handler;
const identityUsers = require(path.join(FN, "identity-users")).handler;
const branding = require(path.join(FN, "branding")).handler;

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
      { venue_id: A, id: "ADMIN-1", name: "Alice-A", email: "alice@a.test", role_id: "role-crew", ...full },
      { venue_id: A, id: "ID-1000", name: "Viewer-A", email: "viewer@a.test", role_id: "role-crew", ...none, perm_inventory: "edit" },
      { venue_id: A, id: "ID-1001", name: "Intern-A", email: "intern@a.test", role_id: "role-intern", ...none },
      { venue_id: A, id: "ID-1002", name: "Gone-A", email: "gone@a.test", role_id: "role-crew", ...none, active: false },
      { venue_id: A, id: "ID-1003", name: "Lookup-A", email: "lookup@a.test", role_id: "role-crew", ...none, perm_employees: "view" },
      { venue_id: B, id: "ADMIN-1", name: "Bob-B", email: "bob@b.test", role_id: "role-b", ...full },
      { venue_id: B, id: "ID-1000", name: "Other-B", email: "other@b.test", role_id: "role-b", ...none }
    ],
    roles: [
      { venue_id: A, id: "role-crew", name: "Crew" }, { venue_id: A, id: "role-intern", name: "Intern" },
      { venue_id: B, id: "role-b", name: "B-only" }
    ],
    items: [
      { venue_id: A, id: "LX-0001", name: "A lamp", status: "ok", location: "Booth", restricted_to: [], holder: null },
      { venue_id: A, id: "LX-0002", name: "A crew-only mic", status: "ok", location: "Booth", restricted_to: ["role-crew"], holder: null },
      { venue_id: A, id: "LX-0003", name: "A broken light", status: "fault", location: "Booth", restricted_to: [], holder: null },
      { venue_id: A, id: "CN-0001", name: "A tape", status: "ok", location: "Booth", restricted_to: [], holder: null, tracking_mode: "consumable", quantity: 10, unit_label: "rolls" },
      { venue_id: B, id: "LX-0001", name: "B lamp", status: "ok", location: "Booth", restricted_to: [], holder: null },
      { venue_id: B, id: "CN-0001", name: "B tape", status: "ok", location: "Booth", restricted_to: [], holder: null, tracking_mode: "consumable", quantity: 5, unit_label: "rolls" }
    ]
  };
}

const ctx = (email) => ({ clientContext: { user: { email } } });
const alice = ctx("alice@a.test"), bob = ctx("bob@b.test"), viewer = ctx("viewer@a.test"), lookup = ctx("lookup@a.test");
const call = (fn, who, method, body, qs, headers) =>
  fn({ httpMethod: method, queryStringParameters: qs || {}, headers: headers || {}, body: body ? JSON.stringify(body) : undefined }, who || {})
    .then((r) => ({ status: r.statusCode, json: JSON.parse(r.body) }));

const makeCode = (who, body) => call(scannerCodes, who || alice, "POST", body || {});
const signIn = (code, extra) => call(scannerSignin, {}, "POST", { code, ...(extra || {}) });
const asScanner = (token, method, body, qs) => call(scanner, {}, method, body, qs, { "x-scanner-token": token });

/** Makes a code and signs a device in with it; returns the token. */
async function newScanner(who, codeBody, name) {
  const c = await makeCode(who, codeBody);
  assert.equal(c.status, 200);
  const s = await signIn(c.json.code.code, name ? { name } : {});
  assert.equal(s.status, 200, JSON.stringify(s.json));
  return { token: s.json.token, code: c.json.code };
}

test.beforeEach(() => { db = makeFake(seed()); });

/* ---------- making and listing codes ---------- */

test("an admin makes a scanner code: 8 characters shown as XXXX-XXXX, valid 1 day, 1 device by default", async () => {
  const r = await makeCode();
  assert.equal(r.status, 200);
  assert.match(r.json.code.code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert.equal(r.json.code.maxDevices, 1);
  assert.equal(r.json.code.state, "active");
  const hours = (new Date(r.json.code.expiresAt) - Date.now()) / 3600000;
  assert.ok(hours > 23.9 && hours < 24.1, "default is 24 hours, got " + hours);
  const row = db.tables.scanner_codes[0];
  assert.equal(row.venue_id, A);
  assert.equal(row.created_by, "ADMIN-1");
});

test("only Employees: edit may make, list or turn off codes, or sign devices out", async () => {
  const { code } = await newScanner();
  const dev = db.tables.scanner_devices[0];
  for (const [method, body, qs] of [["POST", {}], ["GET"], ["DELETE", null, { id: String(code.id) }], ["DELETE", null, { device: String(dev.id) }]]) {
    const r = await call(scannerCodes, viewer, method, body, qs);
    assert.equal(r.status, 403, method + " as someone without Employees: edit");
  }
  // Employees: view (see the roster) is not enough; making scanners needs Employees: edit.
  for (const method of ["POST", "GET"]) assert.equal((await call(scannerCodes, lookup, method, method === "POST" ? {} : null)).status, 403, method + " with view-only Employees");
  const noLogin = await call(scannerCodes, {}, "GET");
  assert.equal(noLogin.status, 401);
});

test("hours and devices are validated", async () => {
  for (const bad of [{ hours: 0 }, { hours: 169 }, { hours: 1.5 }, { hours: "x" }, { maxDevices: 0 }, { maxDevices: 11 }, { maxDevices: 2.5 }]) {
    const r = await makeCode(alice, bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((db.tables.scanner_codes || []).length, 0);
  const ok = await makeCode(alice, { hours: 168, maxDevices: 10, label: "  Booth phone  " });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.code.label, "Booth phone");
});

test("a venue can't pile up more than 20 usable codes", async () => {
  for (let i = 0; i < 20; i++) assert.equal((await makeCode()).status, 200);
  const r = await makeCode();
  assert.equal(r.status, 409);
  const first = (await call(scannerCodes, alice, "GET")).json.codes[0];
  await call(scannerCodes, alice, "DELETE", null, { id: String(first.id) });
  assert.equal((await makeCode()).status, 200, "turning one off makes room");
});

/* ---------- entering a code at sign-in ---------- */

test("a valid code gives the device a token; the database keeps only its hash", async () => {
  const c = await makeCode(alice, { label: "Booth phone" });
  const s = await signIn(c.json.code.code);
  assert.equal(s.status, 200);
  assert.match(s.json.token, /^[0-9a-f]{64}$/);
  assert.equal(s.json.venueName, "Venue A");
  assert.equal(s.json.label, "Booth phone");
  const row = db.tables.scanner_devices[0];
  assert.equal(row.venue_id, A);
  assert.equal(row.token_hash, crypto.createHash("sha256").update(s.json.token).digest("hex"));
  assert.ok(!JSON.stringify(db.tables).includes(s.json.token), "the raw token is never stored");
});

test("people can type the code in lower case, with or without the dash, with spaces", async () => {
  const c = await makeCode(alice, { maxDevices: 3 });
  const raw = c.json.code.code; // XXXX-XXXX
  for (const typed of [raw.toLowerCase(), raw.replace("-", ""), "  " + raw + " "]) {
    assert.equal((await signIn(typed)).status, 200, typed);
  }
});

test("the person can name the scanner; otherwise it gets the code's label, then \"Scanner\"", async () => {
  const named = await newScanner(alice, { label: "Code label" }, "Lobby tablet");
  assert.equal(db.tables.scanner_devices[0].label, "Lobby tablet");
  const labelled = await newScanner(alice, { label: "Code label" });
  assert.equal(db.tables.scanner_devices[1].label, "Code label");
  const plain = await newScanner(alice, {});
  assert.equal(db.tables.scanner_devices[2].label, "Scanner");
  assert.ok(named.token && labelled.token && plain.token);
});

test("wrong, expired, turned-off, used-up and deleted-venue codes all get the same answer", async () => {
  const msgs = new Set();
  const note = (r) => { assert.equal(r.status, 400); msgs.add(r.json.error); };

  note(await signIn("ZZZZ-ZZZZ"));                         // never existed
  note(await signIn(""));                                  // empty
  note(await signIn("short"));                             // wrong length

  const expired = await makeCode();
  db.tables.scanner_codes.find((c) => c.id === expired.json.code.id).expires_at = new Date(Date.now() - 1000).toISOString();
  note(await signIn(expired.json.code.code));

  const off = await makeCode();
  await call(scannerCodes, alice, "DELETE", null, { id: String(off.json.code.id) });
  note(await signIn(off.json.code.code));

  const once = await makeCode();
  assert.equal((await signIn(once.json.code.code)).status, 200);
  note(await signIn(once.json.code.code));                 // used up

  const gone = await makeCode();
  db.tables.venues.find((v) => v.id === A).deleted_at = "2026-03-01";
  note(await signIn(gone.json.code.code));                 // venue is deleted

  assert.equal(msgs.size, 1, "every refusal has the same message: " + [...msgs].join(" | "));
});

test("a one-device code works once; signing that device out does not free its place", async () => {
  const { token, code } = await newScanner();
  assert.equal((await signIn(code.code)).status, 400);
  await asScanner(token, "POST", {}, { action: "signout" });
  assert.equal((await signIn(code.code)).status, 400, "the code was for one device");
});

test("a code for 3 devices works for 3, not 4", async () => {
  const c = await makeCode(alice, { maxDevices: 3 });
  for (let i = 0; i < 3; i++) assert.equal((await signIn(c.json.code.code)).status, 200);
  assert.equal((await signIn(c.json.code.code)).status, 400);
  const list = (await call(scannerCodes, alice, "GET")).json.codes[0];
  assert.equal(list.uses, 3);
  assert.equal(list.state, "used_up");
});

test("if the code is over its limit once the device row exists (two people at once), the newcomer is refused and leaves nothing behind", async () => {
  const c = await makeCode();
  // Someone else's device row appears in the gap between "check" and "insert".
  const realFrom = db.from.bind(db);
  let planted = false;
  db.from = (t) => {
    const q = realFrom(t);
    if (t === "scanner_devices" && !planted) {
      const realInsert = q.insert;
      q.insert = (rows) => {
        if (!planted) {
          planted = true;
          db.tables.scanner_devices.push({ id: 99, venue_id: A, code_id: c.json.code.id, token_hash: "other", label: "x", revoked_at: null });
        }
        return realInsert(rows);
      };
    }
    return q;
  };
  db.tables.scanner_devices = db.tables.scanner_devices || [];
  const r = await signIn(c.json.code.code);
  assert.equal(r.status, 400);
  assert.deepEqual(db.tables.scanner_devices.map((d) => d.token_hash), ["other"], "only the first device remains");
});

test("a venue can have at most 10 scanners signed in at once", async () => {
  for (let i = 0; i < 10; i++) await newScanner();
  const c = await makeCode();
  const r = await signIn(c.json.code.code);
  assert.equal(r.status, 409);
  const devs = (await call(scannerCodes, alice, "GET")).json.devices;
  await call(scannerCodes, alice, "DELETE", null, { device: String(devs[0].id) });
  assert.equal((await signIn(c.json.code.code)).status, 200, "signing one out makes room");
});

/* ---------- what a scanner device can see and do ---------- */

test("a scanner reads only its own venue's items, names and roles, with no emails or permissions to anyone", async () => {
  const { token } = await newScanner(alice, {}, "Booth phone");
  // The in-memory database ignores column lists, so record what the function asked for on "employees".
  const asked = [];
  const realFrom = db.from.bind(db);
  db.from = (t) => {
    const q = realFrom(t);
    if (t === "employees") { const sel = q.select; q.select = (cols, o) => (asked.push(cols), sel(cols, o)); }
    return q;
  };
  const r = await asScanner(token, "GET");
  assert.equal(r.status, 200);
  assert.deepEqual(asked, ["id,name,role_id,active,photo"], "employees: names and roles only, no emails or permissions");
  assert.deepEqual(r.json.items.map((i) => i.name).sort(), ["A broken light", "A crew-only mic", "A lamp", "A tape"]);
  assert.ok(!JSON.stringify(r.json).includes("B lamp") && !JSON.stringify(r.json).includes("Bob-B") && !JSON.stringify(r.json).includes("B-only"));
  assert.deepEqual(r.json.roles.map((x) => x.name).sort(), ["Crew", "Intern"]);
  assert.equal(r.json.employees.length, 5, "this venue's roster only");
  assert.equal(r.json.me.name, "Booth phone");
  assert.equal(r.json.me.perm_inventory, "edit");
  assert.equal(r.json.me.perm_employees, "none");
  assert.equal(r.json.me.perm_settings, "none");
  assert.equal(r.json.me.perm_call_list, "none");
  assert.equal(r.json.branding.appName, "Venue A");
  assert.deepEqual(r.json.callList, []);
});

test("a scanner checks an item out and back in, and the activity log records it", async () => {
  const { token } = await newScanner();
  const out = await asScanner(token, "POST", { itemId: "LX-0001", empId: "ID-1000" }, { action: "checkout" });
  assert.equal(out.status, 200);
  assert.equal(out.json.item.status, "out");
  assert.equal(out.json.item.holder, "ID-1000");
  assert.equal(db.tables.items.find((i) => i.venue_id === A && i.id === "LX-0001").holder, "ID-1000");
  const back = await asScanner(token, "POST", { itemId: "LX-0001" }, { action: "checkin" });
  assert.equal(back.status, 200);
  assert.equal(back.json.item.status, "ok");
  const log = db.tables.activity_log.filter((l) => l.venue_id === A).map((l) => l.type);
  assert.deepEqual(log, ["out", "in"]);
});

test("a scanner obeys the same rules as a person: restricted, inactive, already out, damaged", async () => {
  const { token } = await newScanner();
  const out = (itemId, empId) => asScanner(token, "POST", { itemId, empId }, { action: "checkout" });
  const restricted = await out("LX-0002", "ID-1001"); // intern can't take a crew-only mic
  assert.equal(restricted.status, 403);
  assert.equal(restricted.json.reason, "restricted");
  assert.equal((await out("LX-0002", "ID-1000")).status, 200);       // crew can
  assert.equal((await out("LX-0002", "ID-1000")).status, 409);       // already out
  assert.equal((await out("LX-0001", "ID-1002")).status, 409);       // inactive
  assert.equal((await out("LX-0003", "ID-1000")).status, 409);       // damaged
  assert.equal((await out("LX-0001", "NOPE")).status, 404);          // unknown person
  assert.equal((await out("NOPE", "ID-1000")).status, 404);          // unknown item
  assert.equal((await asScanner(token, "POST", { itemId: "LX-0001" }, { action: "checkin" })).status, 409); // not out
});

test("a scanner uses up stock but can't restock, can't go below zero, and needs a person", async () => {
  const { token } = await newScanner();
  const use = (delta, empId) => asScanner(token, "POST", { itemId: "CN-0001", delta, empId }, { action: "quantity" });
  const ok = await use(-3, "ID-1000");
  assert.equal(ok.status, 200);
  assert.equal(ok.json.item.quantity, 7);
  assert.equal((await use(5, "ID-1000")).status, 403, "adding stock is for the Inventory page");
  assert.equal((await use(0, "ID-1000")).status, 403);
  assert.equal((await use(-1)).status, 400, "no person scanned");
  assert.equal((await use(-8, "ID-1000")).status, 409, "only 7 left");
  assert.equal(db.tables.items.find((i) => i.venue_id === A && i.id === "CN-0001").quantity, 7);
});

test("a scanner can do nothing else: no status changes, notes, restocks, edits or deletes", async () => {
  const { token } = await newScanner();
  for (const action of ["status", "note", "delete", "restock", "", undefined]) {
    const r = await asScanner(token, "POST", { itemId: "LX-0001", status: "fault", note: "x" }, action === undefined ? {} : { action });
    assert.equal(r.status, 403, "action " + action);
  }
  for (const method of ["PUT", "DELETE", "PATCH"]) {
    const r = await asScanner(token, method, { id: "LX-0001", name: "Hacked" }, { id: "LX-0001" });
    assert.equal(r.status, 405, method);
  }
  const lamp = db.tables.items.find((i) => i.venue_id === A && i.id === "LX-0001");
  assert.equal(lamp.status, "ok");
  assert.equal(lamp.name, "A lamp");
  assert.equal(db.tables.items.filter((i) => i.venue_id === A).length, 4);
});

test("ids reused by another venue are safe: a scanner only ever touches its own venue", async () => {
  const { token } = await newScanner();
  await asScanner(token, "POST", { itemId: "LX-0001", empId: "ID-1000" }, { action: "checkout" });
  const b = db.tables.items.find((i) => i.venue_id === B && i.id === "LX-0001");
  assert.equal(b.status, "ok");
  assert.equal(b.holder, null);
  await asScanner(token, "POST", { itemId: "CN-0001", delta: -2, empId: "ID-1000" }, { action: "quantity" });
  assert.equal(db.tables.items.find((i) => i.venue_id === B && i.id === "CN-0001").quantity, 5);
  assert.equal(db.tables.activity_log.filter((l) => l.venue_id === B).length, 0);
});

/* ---------- a scanner token is good for nothing else ---------- */

test("no other function accepts a scanner token", async () => {
  const { token } = await newScanner();
  const headers = { "x-scanner-token": token, authorization: "Bearer " + token };
  const attempts = [
    [bootstrap, "GET"], [items, "GET"], [items, "POST", { id: "X-1", name: "x" }], [items, "POST", { itemId: "LX-0001", empId: "ID-1000" }, { action: "checkout" }],
    [items, "DELETE", null, { id: "LX-0001" }], [employees, "GET"], [employees, "POST", { id: "ID-9", name: "x", email: "x@x.test" }],
    [settings, "GET", null, { resource: "roles" }], [joinCodes, "GET"], [joinCodes, "POST", {}], [joinRequests, "GET"],
    [callList, "GET"], [identityUsers, "POST", { email: "x@x.test", password: "password123" }], [branding, "POST", { appName: "x" }],
    [scannerCodes, "GET"], [scannerCodes, "POST", {}]
  ];
  for (const [fn, method, body, qs] of attempts) {
    const r = await call(fn, {}, method, body, qs, headers);
    assert.ok(r.status === 401 || r.status === 403, method + " got " + r.status);
  }
  assert.equal(db.tables.items.find((i) => i.venue_id === A && i.id === "LX-0001").status, "ok");
  assert.equal((db.tables.scanner_codes || []).length, 1, "no new code was made by the scanner");
});

test("a missing, wrong or oversized token is refused", async () => {
  await newScanner();
  for (const headers of [{}, { "x-scanner-token": "" }, { "x-scanner-token": "nope" }, { "x-scanner-token": "a".repeat(5000) }]) {
    assert.equal((await call(scanner, {}, "GET", null, null, headers)).status, 401);
  }
  const noHeadersAtAll = await scanner({ httpMethod: "GET" }, {});
  assert.equal(noHeadersAtAll.statusCode, 401);
});

test("the header name is not case sensitive", async () => {
  const { token } = await newScanner();
  const r = await call(scanner, {}, "GET", null, null, { "X-Scanner-Token": token });
  assert.equal(r.status, 200);
});

/* ---------- signing out ---------- */

test("signing out on the device stops it working at once", async () => {
  const { token } = await newScanner();
  assert.equal((await asScanner(token, "GET")).status, 200);
  assert.equal((await asScanner(token, "POST", {}, { action: "signout" })).status, 200);
  assert.equal((await asScanner(token, "GET")).status, 401);
  assert.equal((await asScanner(token, "POST", { itemId: "LX-0001", empId: "ID-1000" }, { action: "checkout" })).status, 401);
  assert.equal(db.tables.items.find((i) => i.venue_id === A && i.id === "LX-0001").status, "ok");
});

test("an admin can sign a device out, and it stops working on its next request", async () => {
  const { token } = await newScanner(alice, {}, "Lost phone");
  const list = await call(scannerCodes, alice, "GET");
  assert.deepEqual(list.json.devices.map((d) => d.label), ["Lost phone"]);
  const gone = await call(scannerCodes, alice, "DELETE", null, { device: String(list.json.devices[0].id) });
  assert.equal(gone.status, 200);
  assert.equal((await asScanner(token, "GET")).status, 401);
  assert.deepEqual((await call(scannerCodes, alice, "GET")).json.devices, []);
});

test("turning a code off stops new devices but leaves signed-in ones working", async () => {
  const { token, code } = await newScanner(alice, { maxDevices: 2 });
  await call(scannerCodes, alice, "DELETE", null, { id: String(code.id) });
  assert.equal((await signIn(code.code)).status, 400);
  assert.equal((await asScanner(token, "GET")).status, 200);
});

test("a deleted venue's scanners stop working", async () => {
  const { token } = await newScanner();
  db.tables.venues.find((v) => v.id === A).deleted_at = "2026-03-01";
  assert.equal((await asScanner(token, "GET")).status, 401);
});

test("one venue can't see, turn off or sign out another venue's codes and scanners", async () => {
  const { token, code } = await newScanner();
  const dev = db.tables.scanner_devices[0];
  const list = await call(scannerCodes, bob, "GET");
  assert.deepEqual(list.json, { codes: [], devices: [] });
  assert.equal((await call(scannerCodes, bob, "DELETE", null, { id: String(code.id) })).status, 404);
  assert.equal((await call(scannerCodes, bob, "DELETE", null, { device: String(dev.id) })).status, 404);
  assert.equal((await asScanner(token, "GET")).status, 200, "still signed in");
  assert.equal((await signIn(code.code)).status, 400, "and still used up");
});

test("the code list never shows the token or its hash", async () => {
  const { token } = await newScanner();
  const r = await call(scannerCodes, alice, "GET");
  const text = JSON.stringify(r.json);
  assert.ok(!text.includes(token));
  assert.ok(!text.includes(db.tables.scanner_devices[0].token_hash));
});

/* ---------- the browser side: Store in scanner mode ---------- */

function loadStore(saved) {
  const calls = [];
  const storage = { data: saved ? { "inventorium.scanner": JSON.stringify(saved) } : {} };
  const sandbox = {
    localStorage: { getItem: (k) => (k in storage.data ? storage.data[k] : null), setItem: (k, v) => { storage.data[k] = String(v); }, removeItem: (k) => { delete storage.data[k]; } },
    location: { pathname: "/scan.html", replace: (u) => calls.push(["replace", u]) },
    fetch: async (url, opts) => {
      calls.push(["fetch", url, opts]);
      return sandbox.__reply(url, opts);
    },
    setTimeout, console
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "store.js"), "utf8"), sandbox);
  return { Store: sandbox.Store, calls, storage, sandbox };
}
const reply = (status, json) => ({ ok: status < 400, status, text: async () => JSON.stringify(json) });
const sample = { me: { id: "scanner-1", name: "Booth phone", perm_inventory: "edit", perm_call_list: "none", perm_employees: "none", perm_settings: "none", active: true },
  items: [{ id: "LX-0001", name: "Lamp", status: "ok", restricted_to: [] }], employees: [{ id: "ID-1000", name: "Viewer", role_id: "role-crew", active: true }], roles: [], log: [], callList: [] };

test("browser: with a scanner token the Store sends only X-Scanner-Token, only to the scanner function", async () => {
  const { Store, calls, sandbox } = loadStore({ token: "tok123" });
  assert.equal(Store.scannerMode(), true);
  sandbox.__reply = () => reply(200, sample);
  await Store.load();
  const f = calls.find((c) => c[0] === "fetch");
  assert.equal(f[1], "/.netlify/functions/scanner");
  assert.equal(f[2].headers["X-Scanner-Token"], "tok123");
  assert.equal(f[2].headers.Authorization, undefined);
  assert.equal(Store.can("inventory", "edit"), true);
  assert.equal(Store.can("employees", "view"), false);
  assert.equal(Store.firstAllowedPage(), "scan.html");
  assert.equal(Store.getEmployee("ID-1000").name, "Viewer");
});

test("browser: check-out and use-stock go to the scanner function; anything else is refused before it leaves the device", async () => {
  const { Store, calls, sandbox } = loadStore({ token: "tok123" });
  sandbox.__reply = () => reply(200, sample);
  await Store.load();
  calls.length = 0;
  assert.equal(Store.checkOut("LX-0001", "ID-1000").ok, true);
  await new Promise((r) => setTimeout(r, 20));
  const f = calls.find((c) => c[0] === "fetch");
  assert.equal(f[1], "/.netlify/functions/scanner?action=checkout");
  assert.equal(JSON.parse(f[2].body).itemId, "LX-0001");
  calls.length = 0;
  for (const [m, fn, q] of [["GET", "employees", ""], ["POST", "items", "action=status"], ["POST", "items", ""], ["GET", "join-codes", ""], ["POST", "scanner-codes", ""]]) {
    await assert.rejects(Store.call(m, fn, q, {}), /scanner can only/i, m + " " + fn);
  }
  assert.equal(calls.filter((c) => c[0] === "fetch").length, 0, "nothing was sent");
});

test("browser: a 401 from the server forgets the token and sends the device to the sign-in page", async () => {
  const { Store, calls, storage, sandbox } = loadStore({ token: "tok123" });
  sandbox.__reply = () => reply(401, { error: "This scanner has been signed out." });
  await assert.rejects(Store.load(), (e) => e.status === 401);
  assert.equal(storage.data["inventorium.scanner"], undefined);
  assert.equal(Store.scannerMode(), false);
});

test("browser: signing out tells the server, then forgets the token, even if the server can't be reached", async () => {
  const a = loadStore({ token: "tok123" });
  a.sandbox.__reply = () => reply(200, { ok: true });
  await a.Store.scannerSignOut();
  assert.equal(a.calls.find((c) => c[0] === "fetch")[1], "/.netlify/functions/scanner?action=signout");
  assert.equal(a.Store.scannerMode(), false);

  const b = loadStore({ token: "tok123" });
  b.sandbox.__reply = () => { throw new Error("offline"); };
  await b.Store.scannerSignOut();
  assert.equal(b.Store.scannerMode(), false, "forgotten locally even when offline");
});

test("browser: without a token the Store is in normal mode", () => {
  const { Store } = loadStore(null);
  assert.equal(Store.scannerMode(), false);
  const junk = loadStore({ nottoken: 1 });
  assert.equal(junk.Store.scannerMode(), false);
});
