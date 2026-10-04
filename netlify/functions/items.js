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

const { getSupabaseClient, requirePermission, venueDb, jsonResponse } = require("./_shared/auth");
const { addLog, runItemAction } = require("./_shared/itemactions");

function parseBody(event) {
  try {
    return { body: JSON.parse(event.body || "{}") };
  } catch (e) {
    return { error: jsonResponse(400, { error: "Invalid JSON body." }) };
  }
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
    const { employee: me, error } = await requirePermission(context, supabase, "perm_inventory", "view");
    if (error) return jsonResponse(error.statusCode, { error: error.message });
    const db = venueDb(supabase, me.venue_id);
    const { data, error: dbError } = await db.from("items").select("*").order("name");
    if (dbError) return jsonResponse(500, { error: dbError.message });
    return jsonResponse(200, { items: data });
  }

  if (event.httpMethod === "DELETE") {
    const { employee: me, error } = await requirePermission(context, supabase, "perm_inventory", "edit");
    if (error) return jsonResponse(error.statusCode, { error: error.message });
    const db = venueDb(supabase, me.venue_id);
    if (!qs.id) return jsonResponse(400, { error: "id query parameter is required." });

    const { data: item } = await db.from("items").select("*").eq("id", qs.id).maybeSingle();
    if (!item) return jsonResponse(404, { error: "Item not found." });
    if (item.status === "out") return jsonResponse(409, { error: "Check the item in before deleting it." });

    const { error: dbError } = await db.from("items").delete().eq("id", qs.id);
    if (dbError) return jsonResponse(500, { error: dbError.message });
    await addLog(db, { type: "delete", item_id: qs.id, item_name: item.name });
    return jsonResponse(200, { ok: true });
  }

  if (event.httpMethod !== "POST" && event.httpMethod !== "PUT") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  const { employee, error: permError } = await requirePermission(context, supabase, "perm_inventory", "edit");
  if (permError) return jsonResponse(permError.statusCode, { error: permError.message });
  const db = venueDb(supabase, employee.venue_id);

  const parsed = parseBody(event);
  if (parsed.error) return parsed.error;
  const body = parsed.body;

  /* ----- actions (the rules live in _shared/itemactions.js, shared with scanner.js) ----- */
  if (action) {
    const out = await runItemAction(db, action, body);
    return jsonResponse(out.statusCode, out.body);
  }

  /* ----- create / update details ----- */
  if (!body.id || !body.name) return jsonResponse(400, { error: "id and name are required." });

  const { data: existing } = await db.from("items").select("*").eq("id", body.id).maybeSingle();

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

  const { data, error: dbError } = await db.from("items").upsert(row, { onConflict: "id" }).select().single();
  if (dbError) return jsonResponse(500, { error: dbError.message });
  if (!existing) await addLog(db, { type: "add", item_id: data.id, item_name: data.name });
  return jsonResponse(200, { item: data });
};
