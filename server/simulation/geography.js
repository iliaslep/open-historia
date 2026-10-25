// @ts-check
// Land adjacency derived from shared polygon edges in the scenario, not guessed
// from country names. Islands require a future naval movement model.
/** @typedef {{name:string,owner:string,sovereign:string,neighbors:string[]}} Region */
/** @typedef {{features?: Array<{id?:string,properties?:Record<string,unknown>,geometry?:{type:string,coordinates:number[][][]|number[][][][]}}>}} Geography */
/** @param {unknown} input @param {Record<string,unknown>} world @returns {Record<string,Region>} */
export function buildStrategyGeography(input, world) {
  const collection = /** @type {Geography | undefined} */ (input);
  const ownership = /** @type {Record<string,string>} */ (world.regionOwnershipOverrides || {});
  const sovereignty = /** @type {Record<string,string>} */ (world.regionSovereigntyOverrides || {});
  /** @type {Record<string,Region>} */
  const regions = {};
  /** @type {Map<string,Set<string>>} */
  const edges = new Map();
  /** @param {number[]} p */
  const point = (p) => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;
  for (const feature of collection?.features || []) {
    const props = feature.properties || {};
    const id = String(props.id || feature.id || '');
    const owner = ownership[id] || props.owner;
    if (!id || typeof owner !== 'string' || !owner || !feature.geometry || !['Polygon', 'MultiPolygon'].includes(feature.geometry.type)) continue;
    regions[id] = { name: String(props.name || id), owner,
      sovereign: sovereignty[id] || owner, neighbors: [] };
    const geo = /** @type {NonNullable<typeof feature.geometry>} */ (feature.geometry);
    const polygons = /** @type {number[][][][]} */ (geo.type === 'Polygon' ? [geo.coordinates] : geo.coordinates);
    for (const rings of polygons) for (const ring of rings) for (let i = 1; i < ring.length; i++) {
      const a = point(ring[i - 1]), b = point(ring[i]);
      if (a === b) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const members = edges.get(key) || new Set();
      members.add(id); edges.set(key, members);
    }
  }
  const adjacent = new Map(Object.keys(regions).map((id) => [id, new Set()]));
  for (const owners of edges.values()) if (owners.size > 1) {
    for (const a of owners) for (const b of owners) if (a !== b) adjacent.get(a)?.add(b);
  }
  for (const id of Object.keys(regions)) regions[id].neighbors = [...(adjacent.get(id) || [])].sort();
  return regions;
}
