import { test } from "node:test";
import assert from "node:assert/strict";
import { findJoinPath, buildForwardJoinGraph, resolveJoins, chainTo } from "./joinResolve.js";

function col(id, name, extra = {}) {
  return { id, name, ...extra };
}
function fk(id, name, tableId, columnId) {
  return { id, name, isForeignKey: true, references: { tableId, columnId } };
}
function tableNode(id, label, columns) {
  return { id, type: "tableNode", data: { label, columns } };
}

// orders <- order_items -> products: order_items holds an FK to BOTH
// orders (reverse from orders' perspective - an order has many items) and
// products (forward from order_items' perspective - each item has one
// product). This is the "bring in another table" scenario reported live:
// a model built from orders, with order_items.product_id already exposed,
// couldn't also join products in to read its name.
const orders = tableNode("t_orders", "orders", [col("c_o_id", "id")]);
const orderItems = tableNode("t_items", "order_items", [
  col("c_i_id", "id"),
  fk("c_i_order", "order_id", "t_orders", "c_o_id"),
  fk("c_i_product", "product_id", "t_products", "c_p_id"),
]);
const products = tableNode("t_products", "products", [col("c_p_id", "id"), col("c_p_name", "name")]);
const allNodes = [orders, orderItems, products];
const nodesById = new Map(allNodes.map((n) => [n.id, n]));

// A one-to-many table off order_items (each item may have several
// discount rows) - used to confirm a SECOND reverse hop is not offered.
const orderItemDiscounts = tableNode("t_discounts", "order_item_discounts", [
  col("c_d_id", "id"),
  fk("c_d_item", "order_item_id", "t_items", "c_i_id"),
]);
const allNodesWithDiscounts = [orders, orderItems, orderItemDiscounts];
const nodesByIdWithDiscounts = new Map(allNodesWithDiscounts.map((n) => [n.id, n]));

// A pure forward chain (every hop many-to-one from the base): orders ->
// customers -> regions.
const ordersF = tableNode("t_ordersF", "orders", [
  col("c_ofid", "id"),
  fk("c_of_cust", "customer_id", "t_customersF", "c_cid"),
]);
const customersF = tableNode("t_customersF", "customers", [
  col("c_cid", "id"),
  fk("c_c_region", "region_id", "t_regionsF", "c_rid"),
]);
const regionsF = tableNode("t_regionsF", "regions", [col("c_rid", "id")]);
const allNodesF = [ordersF, customersF, regionsF];
const nodesByIdF = new Map(allNodesF.map((n) => [n.id, n]));

test("findJoinPath - direct 1-hop, either FK direction", () => {
  // order_items AS BASE holds the FK to orders - each item -> at most one order.
  const itemsAsBase = findJoinPath(orderItems, orders);
  assert.equal(itemsAsBase.direction, "base_to_join");
  // orders AS BASE: order_items holds the FK instead - each order -> possibly many items.
  const ordersAsBase = findJoinPath(orders, orderItems);
  assert.equal(ordersAsBase.direction, "join_to_base");
  assert.equal(findJoinPath(orders, products), null, "no direct relationship at all");
});

test("resolveJoins - a table reached by continuing forward off a one-to-many table resolves (orders -> order_items -> products)", () => {
  const result = resolveJoins(orders, [products.id], allNodes, nodesById);
  assert.equal(result.error, undefined);
  const names = result.joinClauses.map((c) => c.tableName);
  assert.deepEqual(names, ["order_items", "products"], "the intermediate hop is auto-included");
  assert.equal(result.joinClauses[0].fromTableName, "orders");
  assert.equal(result.joinClauses[0].tableName, "order_items");
  assert.equal(result.joinClauses[1].fromTableName, "order_items");
  assert.equal(result.joinClauses[1].tableName, "products");
});

test("resolveJoins - requesting both the shared hop and what's beyond it dedupes cleanly", () => {
  const result = resolveJoins(orders, [orderItems.id, products.id], allNodes, nodesById);
  assert.equal(result.error, undefined);
  const names = result.joinClauses.map((c) => c.tableName);
  assert.deepEqual(names, ["order_items", "products"], "order_items appears exactly once");
});

test("resolveJoins - two reverse hops in a row is NOT offered (no compounding fan-out)", () => {
  const result = resolveJoins(orders, [orderItemDiscounts.id], allNodesWithDiscounts, nodesByIdWithDiscounts);
  assert.ok(result.error, "order_item_discounts is two reverse hops from orders - must be rejected");
});

test("resolveJoins - a pure forward multi-hop chain still resolves (orders -> customers -> regions)", () => {
  const result = resolveJoins(ordersF, [regionsF.id], allNodesF, nodesByIdF);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.joinClauses.map((c) => c.tableName), ["customers", "regions"]);
});

test("buildForwardJoinGraph stays strict - never includes a reverse-reached table (calculated-measure 'value' term safety)", () => {
  // This is the graph tablespace.js gates a scalar "value" term on
  // (resolveTerm -> chainTo). It must NEVER widen to include order_items
  // or anything beyond it, or a calculated measure could read "the"
  // product name for an order that actually has several.
  const graph = buildForwardJoinGraph(orders, allNodes);
  assert.equal(chainTo(graph, nodesById, orderItems.id), null);
  assert.equal(chainTo(graph, nodesById, products.id), null);
});

test("buildForwardJoinGraph - pure forward chain is unaffected (orders -> customers -> regions)", () => {
  const graph = buildForwardJoinGraph(ordersF, allNodesF);
  const chain = chainTo(graph, nodesByIdF, regionsF.id);
  assert.deepEqual(chain.map((h) => h.tableName), ["customers", "regions"]);
});
