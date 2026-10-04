/**
 * The item actions (check out, check in, status, quantity, note), shared by two callers:
 *   - items.js    for signed-in people with Inventory: edit
 *   - scanner.js  for scanner devices (which may only use checkout, checkin and a consumable "use")
 * Keeping ONE copy means a scanner device obeys exactly the same rules as a person
 * (restricted items, already checked out, inactive employees, stock can't go below zero ...).
 *
 * runItemAction(db, action, body) -> { statusCode, body } ready for jsonResponse().
 */

function uid(prefix) {
  return prefix + "-" + Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 5);
}

async function addLog(db, entry) {
  entry.id = uid("log");
  entry.ts = new Date().toISOString();
  await db.from("activity_log").insert(entry);
}

function roleAllowed(item, holder) {
  const restrictedTo = Array.isArray(item.restricted_to) ? item.restricted_to : [];
  if (!restrictedTo.length) return true;
  return !!holder && restrictedTo.indexOf(holder.role_id) !== -1;
}

async function runItemAction(db, action, body) {
  const res = (statusCode, b) => ({ statusCode: statusCode, body: b });
  const jsonResponse = res;

  const { data: item } = await db.from("items").select("*").eq("id", body.itemId).maybeSingle();
  if (!item) return jsonResponse(404, { error: "Item not found." });

  if (action === "checkout") {
    const { data: holder } = await db.from("employees").select("*").eq("id", body.empId).maybeSingle();
    if (!holder) return jsonResponse(404, { error: "Employee not found." });
    if (!holder.active) return jsonResponse(409, { error: holder.name + " is inactive." });
    if (item.status === "out") return jsonResponse(409, { error: "Item is already checked out." });
    if (item.status === "maint" || item.status === "fault") {
      return jsonResponse(409, { error: "Item is not available (" + item.status + ")." });
    }
    if (!roleAllowed(item, holder)) {
      return jsonResponse(403, { error: "This item is restricted. " + holder.name + " isn't cleared for it.", reason: "restricted" });
    }
    const { data: updated, error: dbError } = await db
      .from("items")
      .update({ status: "out", holder: holder.id, due: null, updated_at: new Date().toISOString() })
      .eq("id", item.id).select().single();
    if (dbError) return jsonResponse(500, { error: dbError.message });
    await addLog(db, { type: "out", item_id: item.id, item_name: item.name, emp_id: holder.id, emp_name: holder.name });
    return jsonResponse(200, { item: updated });
  }

  if (action === "checkin") {
    if (item.status !== "out") return jsonResponse(409, { error: "Item is not checked out." });
    const { data: prev } = item.holder
      ? await db.from("employees").select("*").eq("id", item.holder).maybeSingle()
      : { data: null };
    const { data: updated, error: dbError } = await db
      .from("items")
      .update({ status: "ok", holder: null, due: null, updated_at: new Date().toISOString() })
      .eq("id", item.id).select().single();
    if (dbError) return jsonResponse(500, { error: dbError.message });
    await addLog(db, {
      type: "in", item_id: item.id, item_name: item.name,
      emp_id: prev ? prev.id : null, emp_name: prev ? prev.name : "Unknown"
    });
    return jsonResponse(200, { item: updated });
  }

  if (action === "status") {
    if (["ok", "maint", "fault"].indexOf(body.status) === -1) return jsonResponse(400, { error: "Invalid status." });
    if (item.status === "out") return jsonResponse(409, { error: "Check the item in first." });
    const labels = { ok: "Cleared — back in service", maint: "Marked in maintenance", fault: "Flagged as damaged" };
    const { data: updated, error: dbError } = await db
      .from("items")
      .update({ status: body.status, holder: null, updated_at: new Date().toISOString() })
      .eq("id", item.id).select().single();
    if (dbError) return jsonResponse(500, { error: dbError.message });
    if (item.status !== body.status) {
      await addLog(db, {
        type: "status", item_id: item.id, item_name: item.name,
        note: labels[body.status] + (body.note ? " — " + body.note : "")
      });
    }
    return jsonResponse(200, { item: updated });
  }

  if (action === "quantity") {
    if (item.tracking_mode !== "consumable") return jsonResponse(409, { error: "That item isn't stock-counted." });
    const delta = Number(body.delta);
    if (!isFinite(delta) || delta === 0) return jsonResponse(400, { error: "delta must be a non-zero number." });
    let who = null;
    if (body.empId) {
      const { data: emp } = await db.from("employees").select("*").eq("id", body.empId).maybeSingle();
      who = emp || null;
      if (!roleAllowed(item, who)) {
        return jsonResponse(403, { error: "This item is restricted" + (who ? ". " + who.name + " isn't cleared for it." : "."), reason: "restricted" });
      }
    }
    const next = (Number(item.quantity) || 0) + delta;
    if (next < 0) return jsonResponse(409, { error: "Not enough in stock." });
    const { data: updated, error: dbError } = await db
      .from("items")
      .update({ quantity: next, updated_at: new Date().toISOString() })
      .eq("id", item.id).select().single();
    if (dbError) return jsonResponse(500, { error: dbError.message });
    const unit = item.unit_label || "units";
    await addLog(db, {
      type: delta >= 0 ? "restock" : "use",
      item_id: item.id, item_name: item.name,
      emp_id: who ? who.id : null, emp_name: who ? who.name : "",
      note: (delta >= 0 ? "+" : "") + delta + " " + unit + (body.note ? " — " + body.note : "") + " (now " + next + " on hand)"
    });
    return jsonResponse(200, { item: updated });
  }

  if (action === "note") {
    const note = String(body.note || "").trim();
    if (!note) return jsonResponse(400, { error: "note is required." });
    await addLog(db, { type: "note", item_id: item.id, item_name: item.name, note: note });
    return jsonResponse(200, { ok: true });
  }

  return jsonResponse(400, { error: "Unknown action." });
}

module.exports = { uid, addLog, roleAllowed, runItemAction };
