/**
 * /api/items
 *
 * GET                       -> list all items            (perm_inventory >= view)
 * POST/PUT {item}           -> create/update item details (edit). Status, holder,
 *                              due and quantity of an EXISTING item are never
 *                              changed here — only by the actions below — so a
 *                              stale browser tab can't overwrite someone else's checkout.
 * DELETE ?id=               -> delete (edit; blocked while checked out)
 * POST ?action=checkout   {itemId, empId}
 * POST ?action=checkin    {itemId}
 * POST ?action=status     {itemId, status, note}   -> available / maint / fault
 * POST ?action=quantity   {itemId, delta, note, empId?} -> consumable restock/use
 * POST ?action=note       {itemId, note}           -> maintenance note
 */

const { getSupabaseClient, requirePermission, jsonResponse } = require("./_shared/auth");

function uid(prefix) {
  return prefix + "-" + Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 5);
}

async function addLog(supabase, entry) {
  entry.id = uid("log");
  entry.ts = new Date().toISOString();
  await supabase.from("activity_log").insert(entry);
}

function parseBody(event) {
  try {
    return { body: JSON.parse(event.body || "{}") };
  } catch (e) {
    return { error: jsonResponse(400, { error: "Invalid JSON body." }) };
  }
}

function roleAllowed(item, holder) {
  const restrictedTo = Array.isArray(item.restricted_to) ? item.restricted_to : [];
  if (!restrictedTo.length) return true;
  return !!holder && restrictedTo.indexOf(holder.role_id) !== -1;
}

exports.handler = async function (event, context) {
  let supabase;
  try {
    supabase = getSupabaseClient();
  } catch (e) {
    return jsonResponse(500, { error: e.message });
  }

  const qs = event.queryStringParameters || {};
  const action = qs.action;

  if (event.httpMethod === "GET") {
    const { error } = await requirePermission(context, supabase, "perm_inventory", "view");
    if (error) return jsonResponse(error.statusCode, { error: error.message });
    const { data, error: dbError } = await supabase.from("items").select("*").order("name");
    if (dbError) return jsonResponse(500, { error: dbError.message });
    return jsonResponse(200, { items: data });
  }

  if (event.httpMethod === "DELETE") {
    const { error } = await requirePermission(context, supabase, "perm_inventory", "edit");
    if (error) return jsonResponse(error.statusCode, { error: error.message });
    if (!qs.id) return jsonResponse(400, { error: "id query parameter is required." });

    const { data: item } = await supabase.from("items").select("*").eq("id", qs.id).maybeSingle();
    if (!item) return jsonResponse(404, { error: "Item not found." });
    if (item.status === "out") return jsonResponse(409, { error: "Check the item in before deleting it." });

    const { error: dbError } = await supabase.from("items").delete().eq("id", qs.id);
    if (dbError) return jsonResponse(500, { error: dbError.message });
    await addLog(supabase, { type: "delete", item_id: qs.id, item_name: item.name });
    return jsonResponse(200, { ok: true });
  }

  if (event.httpMethod !== "POST" && event.httpMethod !== "PUT") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  const { employee, error: permError } = await requirePermission(context, supabase, "perm_inventory", "edit");
  if (permError) return jsonResponse(permError.statusCode, { error: permError.message });

  const parsed = parseBody(event);
  if (parsed.error) return parsed.error;
  const body = parsed.body;

  /* ----- actions ----- */
  if (action) {
    const { data: item } = await supabase.from("items").select("*").eq("id", body.itemId).maybeSingle();
    if (!item) return jsonResponse(404, { error: "Item not found." });

    if (action === "checkout") {
      const { data: holder } = await supabase.from("employees").select("*").eq("id", body.empId).maybeSingle();
      if (!holder) return jsonResponse(404, { error: "Employee not found." });
      if (!holder.active) return jsonResponse(409, { error: holder.name + " is inactive." });
      if (item.status === "out") return jsonResponse(409, { error: "Item is already checked out." });
      if (item.status === "maint" || item.status === "fault") {
        return jsonResponse(409, { error: "Item is not available (" + item.status + ")." });
      }
      if (!roleAllowed(item, holder)) {
        return jsonResponse(403, { error: "This item is restricted. " + holder.name + " isn't cleared for it.", reason: "restricted" });
      }
      const { data: updated, error: dbError } = await supabase
        .from("items")
        .update({ status: "out", holder: holder.id, due: null, updated_at: new Date().toISOString() })
        .eq("id", item.id).select().single();
      if (dbError) return jsonResponse(500, { error: dbError.message });
      await addLog(supabase, { type: "out", item_id: item.id, item_name: item.name, emp_id: holder.id, emp_name: holder.name });
      return jsonResponse(200, { item: updated });
    }

    if (action === "checkin") {
      if (item.status !== "out") return jsonResponse(409, { error: "Item is not checked out." });
      const { data: prev } = item.holder
        ? await supabase.from("employees").select("*").eq("id", item.holder).maybeSingle()
        : { data: null };
      const { data: updated, error: dbError } = await supabase
        .from("items")
        .update({ status: "ok", holder: null, due: null, updated_at: new Date().toISOString() })
        .eq("id", item.id).select().single();
      if (dbError) return jsonResponse(500, { error: dbError.message });
      await addLog(supabase, {
        type: "in", item_id: item.id, item_name: item.name,
        emp_id: prev ? prev.id : null, emp_name: prev ? prev.name : "Unknown"
      });
      return jsonResponse(200, { item: updated });
    }

    if (action === "status") {
      if (["ok", "maint", "fault"].indexOf(body.status) === -1) return jsonResponse(400, { error: "Invalid status." });
      if (item.status === "out") return jsonResponse(409, { error: "Check the item in first." });
      const labels = { ok: "Cleared — back in service", maint: "Marked in maintenance", fault: "Flagged as damaged" };
      const { data: updated, error: dbError } = await supabase
        .from("items")
        .update({ status: body.status, holder: null, updated_at: new Date().toISOString() })
        .eq("id", item.id).select().single();
      if (dbError) return jsonResponse(500, { error: dbError.message });
      if (item.status !== body.status) {
        await addLog(supabase, {
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
        const { data: emp } = await supabase.from("employees").select("*").eq("id", body.empId).maybeSingle();
        who = emp || null;
        if (!roleAllowed(item, who)) {
          return jsonResponse(403, { error: "This item is restricted" + (who ? ". " + who.name + " isn't cleared for it." : "."), reason: "restricted" });
        }
      }
      const next = (Number(item.quantity) || 0) + delta;
      if (next < 0) return jsonResponse(409, { error: "Not enough in stock." });
      const { data: updated, error: dbError } = await supabase
        .from("items")
        .update({ quantity: next, updated_at: new Date().toISOString() })
        .eq("id", item.id).select().single();
      if (dbError) return jsonResponse(500, { error: dbError.message });
      const unit = item.unit_label || "units";
      await addLog(supabase, {
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
      await addLog(supabase, { type: "note", item_id: item.id, item_name: item.name, note: note });
      return jsonResponse(200, { ok: true });
    }

    return jsonResponse(400, { error: "Unknown action." });
  }

  /* ----- create / update details ----- */
  if (!body.id || !body.name) return jsonResponse(400, { error: "id and name are required." });

  const { data: existing } = await supabase.from("items").select("*").eq("id", body.id).maybeSingle();

  const row = {
    id: body.id,
    group_id: body.groupId || null,
    name: body.name,
    category: body.category || null,
    location: body.location || null,
    aliases: body.aliases || null,
    notes: body.notes || null,
    restricted_to: Array.isArray(body.restrictedTo) ? body.restrictedTo : [],
    photo: body.photo || null,
    serial: body.serial || null,
    condition: body.condition || null,
    purchase_date: body.purchaseDate || null,
    purchase_cost: body.purchaseCost === "" || body.purchaseCost == null ? null : Number(body.purchaseCost),
    manual_url: body.manualUrl || null,
    tracking_mode: body.trackingMode || null,
    unit_label: body.unitLabel || null,
    min_quantity: body.minQuantity == null ? null : Number(body.minQuantity),
    updated_at: new Date().toISOString()
  };
  if (!existing) {
    row.status = "ok";
    row.quantity = body.trackingMode === "consumable" ? Number(body.quantity) || 0 : null;
  }

  const { data, error: dbError } = await supabase.from("items").upsert(row, { onConflict: "id" }).select().single();
  if (dbError) return jsonResponse(500, { error: dbError.message });
  if (!existing) await addLog(supabase, { type: "add", item_id: data.id, item_name: data.name });
  return jsonResponse(200, { item: data });
};
