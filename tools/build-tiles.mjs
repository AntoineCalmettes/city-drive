// Prétraitement OSM -> tuiles JSON pour city-drive Marseille.
// usage: node tools/build-tiles.mjs <dossier osm-raw> <dossier sortie>
import fs from 'fs';
import path from 'path';

const RAW = process.argv[2] || 'osm-raw';
const OUT = process.argv[3] || 'tiles';
const LAT0 = 43.2951, LON0 = 5.3744;               // Vieux-Port
const KX = Math.cos(LAT0 * Math.PI / 180) * 111320, KZ = 110540;
const TILE = 500;                                    // m
const X0 = -12500, Z0 = -11500, NX = 52, NZ = 52;    // emprise des tuiles
const CELL = 5, GW = NX * TILE / CELL, GH = NZ * TILE / CELL; // masque terre/mer

const px = (lon) => (lon - LON0) * KX;
const pz = (lat) => -(lat - LAT0) * KZ;
const load = (f) => JSON.parse(fs.readFileSync(path.join(RAW, f)));

const tiles = new Map();
const tile = (i, j) => {
  const k = i + '_' + j;
  if (!tiles.has(k)) tiles.set(k, { i, j, r: [], n: [], nIdx: new Map(), b: [], a: [], m: [] });
  return tiles.get(k);
};
const tileOf = (x, z) => [Math.floor((x - X0) / TILE), Math.floor((z - Z0) / TILE)];
const inGrid = (i, j) => i >= 0 && j >= 0 && i < NX && j < NZ;
// coordonnées en décimètres relatives à l'origine de la tuile
const enc = (t, pts) => {
  const ox = X0 + t.i * TILE, oz = Z0 + t.j * TILE, o = [];
  for (const [x, z] of pts) o.push(Math.round((x - ox) * 10), Math.round((z - oz) * 10));
  return o;
};
const geomPts = (g) => g.map((p) => [px(p.lon), pz(p.lat)]);

// assemble des morceaux de ways en anneaux fermés (multipolygones)
function rings(parts) {
  parts = parts.filter((p) => p.length > 1).map((p) => p.slice());
  const out = [];
  const same = (a, b) => Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;
  while (parts.length) {
    let cur = parts.shift();
    let grew = true;
    while (!same(cur[0], cur[cur.length - 1]) && grew) {
      grew = false;
      for (let k = 0; k < parts.length; k++) {
        const p = parts[k], end = cur[cur.length - 1];
        if (same(end, p[0])) cur = cur.concat(p.slice(1));
        else if (same(end, p[p.length - 1])) cur = cur.concat(p.slice(0, -1).reverse());
        else continue;
        parts.splice(k, 1); grew = true; break;
      }
    }
    if (cur.length >= 4) out.push(cur);
  }
  return out;
}
function polysOf(e) {
  if (e.type === 'way' && e.geometry) return [geomPts(e.geometry)];
  if (e.type === 'relation' && e.members)
    return rings(e.members.filter((m) => m.role === 'outer' && m.geometry).map((m) => geomPts(m.geometry)));
  return [];
}
const openRing = (p) => (p.length > 1 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1] ? p.slice(0, -1) : p);
const area = (p) => { let s = 0; for (let k = 0; k < p.length; k++) { const a = p[k], b = p[(k + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
const centroid = (p) => { let x = 0, z = 0; for (const q of p) { x += q[0]; z += q[1]; } return [x / p.length, z / p.length]; };

// Sutherland-Hodgman sur un rectangle
function clipRect(poly, x0, z0, x1, z1) {
  const edges = [
    (p) => p[0] >= x0, (p) => p[0] <= x1, (p) => p[1] >= z0, (p) => p[1] <= z1,
  ];
  const cut = [
    (a, b) => [x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0])],
    (a, b) => [x1, a[1] + (b[1] - a[1]) * (x1 - a[0]) / (b[0] - a[0])],
    (a, b) => [a[0] + (b[0] - a[0]) * (z0 - a[1]) / (b[1] - a[1]), z0],
    (a, b) => [a[0] + (b[0] - a[0]) * (z1 - a[1]) / (b[1] - a[1]), z1],
  ];
  let out = poly;
  for (let e = 0; e < 4 && out.length; e++) {
    const inp = out; out = [];
    for (let k = 0; k < inp.length; k++) {
      const a = inp[k], b = inp[(k + 1) % inp.length], ia = edges[e](a), ib = edges[e](b);
      if (ia) out.push(a);
      if (ia !== ib) out.push(cut[e](a, b));
    }
  }
  return out;
}
function addPolyClipped(poly, fn) {
  let mnx = 1e9, mnz = 1e9, mxx = -1e9, mxz = -1e9;
  for (const [x, z] of poly) { mnx = Math.min(mnx, x); mxx = Math.max(mxx, x); mnz = Math.min(mnz, z); mxz = Math.max(mxz, z); }
  const [i0, j0] = tileOf(mnx, mnz), [i1, j1] = tileOf(mxx, mxz);
  for (let i = Math.max(0, i0); i <= Math.min(NX - 1, i1); i++)
    for (let j = Math.max(0, j0); j <= Math.min(NZ - 1, j1); j++) {
      const x0 = X0 + i * TILE, z0 = Z0 + j * TILE;
      const c = i0 === i1 && j0 === j1 ? poly : clipRect(poly, x0, z0, x0 + TILE, z0 + TILE);
      if (c.length >= 3 && Math.abs(area(c)) > 1) fn(tile(i, j), c);
    }
}

// ---------- masque terre / mer ----------
const mask = new Uint8Array(GW * GH); // 0 = inconnu(terre), 1 = barrière, 2 = mer
function stamp(pts, v, rad = 0) {
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
    const len = Math.hypot(bx - ax, bz - az), steps = Math.max(1, Math.ceil(len / 1));
    for (let s = 0; s <= steps; s++) {
      const x = ax + (bx - ax) * s / steps, z = az + (bz - az) * s / steps;
      const cx = Math.floor((x - X0) / CELL), cz = Math.floor((z - Z0) / CELL);
      for (let dz = -rad; dz <= rad; dz++) for (let dx = -rad; dx <= rad; dx++) {
        const gx = cx + dx, gz = cz + dz;
        if (gx >= 0 && gz >= 0 && gx < GW && gz < GH && (v === 1 || mask[gz * GW + gx] === 2)) mask[gz * GW + gx] = v;
      }
    }
  }
}
function floodSea(seeds) {
  const st = [];
  for (const [lat, lon] of seeds) {
    const gx = Math.floor((px(lon) - X0) / CELL), gz = Math.floor((pz(lat) - Z0) / CELL);
    if (mask[gz * GW + gx] === 0) { mask[gz * GW + gx] = 2; st.push(gz * GW + gx); }
  }
  while (st.length) {
    const c = st.pop(), x = c % GW, z = (c - x) / GW;
    if (x > 0 && mask[c - 1] === 0) { mask[c - 1] = 2; st.push(c - 1); }
    if (x < GW - 1 && mask[c + 1] === 0) { mask[c + 1] = 2; st.push(c + 1); }
    if (z > 0 && mask[c - GW] === 0) { mask[c - GW] = 2; st.push(c - GW); }
    if (z < GH - 1 && mask[c + GW] === 0) { mask[c + GW] = 2; st.push(c + GW); }
  }
}

// ---------- routes ----------
const ROADW = {
  motorway: 13, trunk: 12, primary: 11, secondary: 9, tertiary: 8, unclassified: 6, residential: 6,
  living_street: 5, service: 4, pedestrian: 5, track: 3,
  motorway_link: 6, trunk_link: 6, primary_link: 6, secondary_link: 6, tertiary_link: 6,
};
const ROADCLS = { motorway: 0, trunk: 0, motorway_link: 1, trunk_link: 1, primary: 1, primary_link: 1, secondary: 2, secondary_link: 2, tertiary: 2, tertiary_link: 2, pedestrian: 4, track: 5 };
const roadsRaw = load('roads.json').elements;
const roadPolylines = [];
let nRoads = 0;
for (const e of roadsRaw) {
  if (!e.geometry || e.tags.tunnel === 'yes' || e.tags.tunnel === 'building_passage' && e.tags.highway === 'service') continue;
  if (e.tags.area === 'yes') continue;
  const hw = e.tags.highway;
  let w = ROADW[hw] || 5;
  if (e.tags.oneway === 'yes' && w > 8) w *= 0.65;
  if (e.tags.lanes) { const l = parseInt(e.tags.lanes); if (l > 0 && l < 9) w = Math.max(w * 0.5, Math.min(w * 1.3, l * 3.3 + 1)); }
  const cls = ROADCLS[hw] ?? 3;
  const pts = geomPts(e.geometry);
  roadPolylines.push(pts);
  const name = e.tags.name || e.tags.ref || '';
  // découpe par tuile selon le milieu de chaque segment
  let curT = null, run = [];
  const flush = () => {
    if (curT && run.length > 1) {
      let ni = -1;
      if (name) { if (!curT.nIdx.has(name)) { curT.nIdx.set(name, curT.n.length); curT.n.push(name); } ni = curT.nIdx.get(name); }
      curT.r.push([cls, Math.round(w * 10), ni, enc(curT, run)]);
    }
  };
  for (let k = 0; k + 1 < pts.length; k++) {
    const [i, j] = tileOf((pts[k][0] + pts[k + 1][0]) / 2, (pts[k][1] + pts[k + 1][1]) / 2);
    if (!inGrid(i, j)) { flush(); curT = null; run = []; continue; }
    const t = tile(i, j);
    if (t !== curT) { flush(); curT = t; run = [pts[k]]; }
    run.push(pts[k + 1]);
  }
  flush();
  nRoads++;
}
console.log('routes', nRoads);

// ---------- zones (parcs, bois, eau, plages...) + monuments ----------
const areasRaw = load('areas.json').elements;
const coast = [];
const MON = new Set();
const areaKind = (t) => {
  if (t.natural === 'water' || t.water) return 'water';
  if (t.natural === 'beach') return 'beach';
  if (t.natural === 'wood' || t.landuse === 'forest') return 'wood';
  if (t.natural === 'scrub') return 'scrub';
  if (t.landuse === 'cemetery') return 'cemetery';
  if (t.leisure === 'pitch' || t.leisure === 'stadium') return 'pitch';
  if (t.leisure === 'park' || t.leisure === 'garden' || t.landuse === 'grass' || t.landuse === 'meadow' || t.landuse === 'recreation_ground') return 'park';
  return null;
};
const AKIND = { park: 0, wood: 1, scrub: 2, water: 3, beach: 4, cemetery: 5, pitch: 6 };
let nAreas = 0, nMon = 0;
for (const e of areasRaw) {
  const t = e.tags || {};
  if (t.natural === 'coastline') { if (e.geometry) coast.push(geomPts(e.geometry)); continue; }
  // monuments / lieux remarquables : un repère nommé
  if ((t.historic || t.tourism) && t.name && !MON.has(t.name)) {
    let x, z;
    if (e.type === 'node') { x = px(e.lon); z = pz(e.lat); }
    else if (e.bounds) { x = px((e.bounds.minlon + e.bounds.maxlon) / 2); z = pz((e.bounds.minlat + e.bounds.maxlat) / 2); }
    if (x !== undefined) {
      const [i, j] = tileOf(x, z);
      if (inGrid(i, j)) {
        const tt = tile(i, j), [ex, ez] = enc(tt, [[x, z]]);
        tt.m.push([t.name, ex, ez, t.historic ? 1 : 0]); MON.add(t.name); nMon++;
      }
    }
  }
  const k = areaKind(t);
  if (k === null || e.type === 'node') continue;
  for (const p of polysOf(e)) {
    const poly = openRing(p);
    if (poly.length < 3 || Math.abs(area(poly)) > 5e7) continue;
    addPolyClipped(poly, (tt, c) => tt.a.push([AKIND[k], enc(tt, c)]));
    nAreas++;
  }
}
console.log('zones', nAreas, 'monuments', nMon, 'côte', coast.length);

// mer : la côte fait barrière, on remplit depuis le large, puis les routes (quais, jetées) redeviennent terre
for (const c of coast) stamp(c, 1);
floodSea([[43.22, 5.25], [43.175, 5.45], [43.33, 5.30]]);
for (const p of roadPolylines) stamp(p, 0, 1);
for (let k = 0; k < mask.length; k++) if (mask[k] === 1) mask[k] = 0;

// ---------- bâtiments ----------
const bfiles = fs.readdirSync(RAW).filter((f) => /^bld_\d+\.json$/.test(f));
const seen = new Set();
const RES = new Set(['house', 'detached', 'semidetached_house', 'bungalow', 'villa', 'terrace', 'garage', 'garages', 'shed', 'hut', 'cabin', 'roof']);
const IND = new Set(['industrial', 'warehouse', 'retail', 'commercial', 'hangar', 'service', 'storage_tank', 'supermarket', 'parking', 'transportation', 'train_station']);
const REL = new Set(['church', 'cathedral', 'chapel', 'basilica', 'mosque', 'synagogue', 'temple', 'religious']);
let nB = 0;
for (const f of bfiles) {
  for (const e of load(f).elements) {
    const id = e.type[0] + e.id;
    if (seen.has(id)) continue; seen.add(id);
    const t = e.tags || {};
    if (t.building === 'no' || t.building === 'construction' && !t.height) continue;
    const bt = t.building;
    let kind = 0;
    if (t.historic || t.tourism || REL.has(bt) || t.amenity === 'place_of_worship') kind = REL.has(bt) || t.amenity === 'place_of_worship' ? 4 : 1;
    else if (RES.has(bt)) kind = 3;
    else if (IND.has(bt)) kind = 2;
    for (const p of polysOf(e)) {
      let poly = openRing(p);
      if (poly.length < 3) continue;
      const ar = Math.abs(area(poly));
      if (ar < 6) continue;
      if (area(poly) < 0) poly = poly.slice().reverse(); // sens constant
      let h = parseFloat(t.height || t['building:height']);
      const lv = parseFloat(t['building:levels']);
      if (!(h > 0)) {
        if (lv > 0) h = lv * 3.1 + (t['roof:levels'] ? parseFloat(t['roof:levels']) * 2 : 1);
        else if (kind === 3) h = bt === 'garage' || bt === 'shed' || bt === 'garages' ? 3 : 6.5;
        else if (kind === 2) h = 9;
        else if (kind === 4) h = 18;
        else {
          const [cx, cz] = centroid(poly), d = Math.hypot(cx, cz);
          h = ar < 90 ? 7 : d < 2500 ? 17 : d < 5000 ? 13 : 9;
        }
      }
      h = Math.min(h, 250);
      const [cx, cz] = centroid(poly), [i, j] = tileOf(cx, cz);
      if (!inGrid(i, j)) continue;
      const tt = tile(i, j);
      tt.b.push([Math.round(h * 10), kind, enc(tt, poly)]);
      nB++;
    }
  }
}
console.log('bâtiments', nB);

// ---------- écriture ----------
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (f.startsWith('t_')) fs.unlinkSync(path.join(OUT, f));
const list = [];
const CPT = TILE / CELL;
let bytes = 0;
for (let i = 0; i < NX; i++) for (let j = 0; j < NZ; j++) {
  // masque terre en runs par ligne [début, longueur] (en cellules de 5 m)
  const k = [];
  let landAny = false, seaAny = false;
  for (let r = 0; r < CPT; r++) {
    const row = [], gz = j * CPT + r;
    let s = -1;
    for (let c = 0; c <= CPT; c++) {
      const land = c < CPT && mask[gz * GW + i * CPT + c] !== 2;
      if (c < CPT) land ? (landAny = true) : (seaAny = true);
      if (land && s < 0) s = c;
      if (!land && s >= 0) { row.push(s, c - s); s = -1; }
    }
    k.push(row);
  }
  const key = i + '_' + j;
  const t = tiles.get(key);
  if (!t && !landAny) continue;
  const o = { r: t ? t.r : [], n: t ? t.n : [], b: t ? t.b : [], a: t ? t.a : [], m: t ? t.m : [], k: seaAny ? k : 1 };
  const s = JSON.stringify(o);
  bytes += s.length;
  fs.writeFileSync(path.join(OUT, 't_' + key + '.json'), s);
  list.push(key);
}
// point de départ : bas de la Canebière
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({
  tile: TILE, x0: X0, z0: Z0, nx: NX, nz: NZ, cell: CELL, lat0: LAT0, lon0: LON0,
  spawn: [px(5.3772), pz(43.2967)], tiles: list,
}));
console.log('tuiles', list.length, 'Mo', (bytes / 1e6).toFixed(1));
