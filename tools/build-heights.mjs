// Ajoute le relief aux tuiles : grille d'altitude (pas de 20 m) dans le champ "h" de chaque tuile.
// Source : tuiles Terrarium (AWS Open Data, https://registry.opendata.aws/terrain-tiles/), zoom 13 (~14 m/pixel).
// Usage : node tools/build-heights.mjs <dossier cache dem> <dossier tuiles>   (après build-tiles.mjs)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const [DEM, OUT] = process.argv.slice(2);
const Z = 13, STEP = 20;
fs.mkdirSync(DEM, { recursive: true });
const idx = JSON.parse(fs.readFileSync(path.join(OUT, 'index.json')));
const { tile: TILE, x0: X0, z0: Z0, nx: NX, nz: NZ, lat0, lon0 } = idx;
const KX = Math.cos(lat0 * Math.PI / 180) * 111320, KZ = 110540;
const PER = TILE / STEP;                 // 25 intervalles par tuile
const GW = NX * PER + 1, GH = NZ * PER + 1;

// décodeur PNG minimal (8 bits, RGB/RGBA, non entrelacé)
function decodePNG(buf) {
  let o = 8, w, h, ct;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; if (d[8] !== 8 || d[12]) throw new Error('PNG non géré'); }
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : (() => { throw new Error('PNG type ' + ct); })();
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0, b = y ? px[dst + x - stride] : 0, c = x >= bpp && y ? px[dst + x - stride - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + x] = v & 255;
    }
  }
  const out = new Float32Array(w * h);
  for (let k = 0; k < w * h; k++) out[k] = px[k * bpp] * 256 + px[k * bpp + 1] + px[k * bpp + 2] / 256 - 32768;
  return out;
}

const cache = new Map();
async function demTile(tx, ty) {
  const k = tx + '_' + ty;
  if (cache.has(k)) return cache.get(k);
  const f = path.join(DEM, `${Z}_${tx}_${ty}.png`);
  if (!fs.existsSync(f)) {
    for (let a = 0; ; a++) {
      try {
        const r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${tx}/${ty}.png`);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
        break;
      } catch (e) { if (a > 4) throw e; await new Promise((r) => setTimeout(r, 2000 * (a + 1))); }
    }
  }
  const d = decodePNG(fs.readFileSync(f));
  cache.set(k, d);
  return d;
}

const N = 2 ** Z * 256;
async function elev(lat, lon) {
  const px = (lon + 180) / 360 * N - 0.5;
  const s = Math.sin(lat * Math.PI / 180), py = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * N - 0.5;
  const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
  const at = async (x, y) => (await demTile(x >> 8, y >> 8))[(y & 255) * 256 + (x & 255)];
  const a = await at(x0, y0), b = await at(x0 + 1, y0), c = await at(x0, y0 + 1), d = await at(x0 + 1, y0 + 1);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

// grille globale, mer ramenée à 0
const g = new Float32Array(GW * GH);
for (let j = 0; j < GH; j++) {
  for (let i = 0; i < GW; i++) {
    const x = X0 + i * STEP, z = Z0 + j * STEP;
    g[j * GW + i] = Math.max(0, await elev(lat0 - z / KZ, lon0 + x / KX));
  }
  if (j % 100 === 0) process.stdout.write(`ligne ${j}/${GH} (tuiles dem ${cache.size})\r`);
}
// lissage (2 passes de flou 3x3) pour adoucir le bruit du MNT sous les routes
for (let pass = 0; pass < 2; pass++) {
  const s = g.slice();
  for (let j = 1; j < GH - 1; j++) for (let i = 1; i < GW - 1; i++) {
    let t = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) t += s[(j + dj) * GW + i + di] * (di && dj ? 1 : di || dj ? 2 : 4);
    g[j * GW + i] = t / 16;
  }
}

let mx = 0;
for (const key of idx.tiles) {
  const [ti, tj] = key.split('_').map(Number), f = path.join(OUT, `t_${key}.json`), d = JSON.parse(fs.readFileSync(f));
  d.h = [];
  for (let r = 0; r <= PER; r++) for (let c = 0; c <= PER; c++) {
    const v = Math.round(g[(tj * PER + r) * GW + ti * PER + c] * 10);
    d.h.push(v); mx = Math.max(mx, v);
  }
  fs.writeFileSync(f, JSON.stringify(d));
}
idx.hstep = STEP;
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(idx));
console.log(`\nrelief ajouté à ${idx.tiles.length} tuiles, altitude max ${(mx / 10).toFixed(0)} m`);
