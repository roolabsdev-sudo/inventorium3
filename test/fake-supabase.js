/**
 * A small in-memory stand-in for the parts of supabase-js that the functions use.
 * It enforces the same keys and links as the real database after db/venues-ids.sql:
 * primary keys are (venue_id, id), names are unique per venue, emails are unique
 * everywhere, and links between tables must stay inside one venue.
 */
const clone = (x) => JSON.parse(JSON.stringify(x));

const PK = { venues: ["id"] };
const UNIQUE = {
  employees: [["email"]],
  roles: [["venue_id", "name"]],
  locations: [["venue_id", "name"]],
  show_roles: [["venue_id", "name"]],
  call_list: [["venue_id", "show_id", "emp_id"]]
};
const FKS = [
  { table: "items", cols: ["holder"], ref: "employees", onDelete: "null" },
  { table: "call_list", cols: ["show_id"], ref: "shows", onDelete: "cascade" },
  { table: "call_list", cols: ["emp_id"], ref: "employees", onDelete: "cascade" },
  { table: "call_list", cols: ["show_role_id"], ref: "show_roles", onDelete: "null" }
];
const pkOf = (t) => PK[t] || ["venue_id", "id"];
const same = (a, b, cols) => cols.every((c) => a[c] === b[c]);

function makeFake(seed) {
  const tables = clone(seed);
  const rowsOf = (t) => (tables[t] = tables[t] || []);
  const err = (code, message) => ({ code, message });

  function checkInsert(t, row, ignoreRow) {
    if (t !== "venues" && !row.venue_id) return err("23502", "null venue_id in " + t);
    for (const cols of [pkOf(t)].concat(UNIQUE[t] || [])) {
      if (cols.some((c) => row[c] == null)) continue;
      if (rowsOf(t).some((r) => r !== ignoreRow && same(r, row, cols))) return err("23505", "duplicate key on " + t + " (" + cols + ")");
    }
    for (const fk of FKS.filter((f) => f.table === t)) {
      if (fk.cols.some((c) => row[c] == null)) continue;
      const ok = rowsOf(fk.ref).some((p) => p.venue_id === row.venue_id && fk.cols.every((c) => p.id === row[c]));
      if (!ok) return err("23503", "link from " + t + "." + fk.cols + " leaves the venue");
    }
    return null;
  }

  function cascadeDelete(t, removed) {
    for (const fk of FKS.filter((f) => f.ref === t)) {
      for (const parent of removed) {
        const kids = rowsOf(fk.table).filter((k) => k.venue_id === parent.venue_id && fk.cols.every((c) => k[c] === parent.id));
        if (fk.onDelete === "cascade") {
          tables[fk.table] = rowsOf(fk.table).filter((k) => kids.indexOf(k) === -1);
          cascadeDelete(fk.table, kids);
        } else kids.forEach((k) => fk.cols.forEach((c) => (k[c] = null)));
      }
    }
  }

  function builder(t, op, payload, opts) {
    const st = { filters: [], order: null, limit: null, single: null, returning: op === "select" };
    const api = {
      eq: (c, v) => (st.filters.push((r) => r[c] === v), api),
      neq: (c, v) => (st.filters.push((r) => r[c] !== v), api),
      is: (c, v) => (st.filters.push((r) => (v === null ? r[c] == null : r[c] === v)), api),
      contains: (c, arr) => (st.filters.push((r) => Array.isArray(r[c]) && arr.every((x) => r[c].indexOf(x) !== -1)), api),
      order: (c, o) => ((st.order = [c, !(o && o.ascending === false)]), api),
      limit: (n) => ((st.limit = n), api),
      select: () => ((st.returning = true), api),
      single: () => ((st.single = "single"), api),
      maybeSingle: () => ((st.single = "maybe"), api),
      then: (res, rej) => Promise.resolve(run()).then(res, rej)
    };

    function shape(rows) {
      let out = rows.map(clone);
      if (st.single) {
        if (out.length > 1) return { data: null, error: err("PGRST116", "multiple rows") };
        if (out.length === 0) return st.single === "maybe" ? { data: null, error: null } : { data: null, error: err("PGRST116", "no rows") };
        return { data: out[0], error: null };
      }
      return { data: out, error: null };
    }

    function run() {
      const all = rowsOf(t);
      const match = () => all.filter((r) => st.filters.every((f) => f(r)));
      if (op === "select") {
        let rows = match();
        if (st.order) rows = rows.slice().sort((a, b) => (String(a[st.order[0]]) < String(b[st.order[0]]) ? -1 : 1) * (st.order[1] ? 1 : -1));
        if (st.limit != null) rows = rows.slice(0, st.limit);
        if (opts && opts.head) return { data: null, count: rows.length, error: null };
        const res = shape(rows);
        if (opts && opts.count) res.count = rows.length;
        return res;
      }
      if (op === "insert" || op === "upsert") {
        const list = Array.isArray(payload) ? payload : [payload];
        const done = [];
        for (const raw of list) {
          const row = clone(raw);
          const conflictCols = op === "upsert" ? String((opts && opts.onConflict) || pkOf(t).join(",")).split(",") : null;
          const existing = conflictCols ? all.find((r) => same(r, row, conflictCols)) : null;
          if (existing) {
            if (opts && opts.ignoreDuplicates) continue;
            const merged = Object.assign({}, existing, row);
            const e = checkInsert(t, merged, existing);
            if (e) return { data: null, error: e };
            Object.assign(existing, row);
            done.push(existing);
          } else {
            const e = checkInsert(t, row, null);
            if (e) return { data: null, error: e };
            all.push(row);
            done.push(row);
          }
        }
        return st.returning ? shape(done) : { data: null, error: null };
      }
      if (op === "update") {
        const rows = match();
        rows.forEach((r) => Object.assign(r, payload));
        return st.returning ? shape(rows) : { data: null, error: null };
      }
      if (op === "delete") {
        const rows = match();
        tables[t] = all.filter((r) => rows.indexOf(r) === -1);
        cascadeDelete(t, rows);
        return { data: null, error: null };
      }
    }
    return api;
  }

  return {
    tables,
    from: (t) => ({
      select: (cols, opts) => builder(t, "select", null, opts),
      insert: (rows) => builder(t, "insert", rows),
      upsert: (rows, opts) => builder(t, "upsert", rows, opts),
      update: (patch) => builder(t, "update", patch),
      delete: () => builder(t, "delete")
    })
  };
}

module.exports = { makeFake };
