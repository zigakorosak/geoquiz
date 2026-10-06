// Regenerates public/data/china.json + china-topology.json — China's
// provincial-level divisions: 23 provinces (Taiwan included, as the PRC's
// own administrative list does — a deliberate product decision), 5
// autonomous regions, 4 municipalities and 2 special administrative
// regions. 34 items.
//
// Run with: node scripts/generate-china-data.mjs [path/to/ne_10m_admin_1_states_provinces.geojson]
//
// Source: Natural Earth 1:10m admin-1 (public domain). Without a path
// argument the GeoJSON (~40 MB) is downloaded from Natural Earth's GitHub.
// Natural Earth splits Taiwan into its counties and Hong Kong into its 18
// districts; each is merged back into one feature here. The Paracel
// Islands come as a separate "CHN" feature — disputed, and folding them
// into Hainan would stretch Hainan's outline (and its tap-assist hull)
// across the South China Sea — so they're dropped.
//
// Unlike us-states, coordinates stay real lon/lat (projected at runtime
// by WorldMap's "china" projection), so drop-a-pin and capital-distance
// modes work here too.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { topology } from "topojson-server";
import { merge, feature, quantize } from "topojson-client";
import { presimplify, simplify, quantile } from "topojson-simplify";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", "public", "data");
const NE_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson";

const src = process.argv[2]
  ? JSON.parse(readFileSync(process.argv[2], "utf8"))
  : await (await fetch(NE_URL)).json();

// Capitals, hand-curated (stable, well-known facts — same approach as
// generate-us-states-data.mjs), with coordinates [lat, lon] for the
// capital-pin mode. Municipalities and SARs are cities themselves and
// have no separate capital: `capital: null` keeps them out of capital
// rounds (gameWizard.js's isAskable) while leaving them playable for
// name/location — same treatment as Washington DC in us-states.
const CAPITALS = {
  Anhui: ["Hefei", [31.82, 117.23]],
  Fujian: ["Fuzhou", [26.07, 119.3]],
  Gansu: ["Lanzhou", [36.06, 103.83]],
  Guangdong: ["Guangzhou", [23.13, 113.26]],
  Guizhou: ["Guiyang", [26.65, 106.63]],
  Hainan: ["Haikou", [20.04, 110.2]],
  Hebei: ["Shijiazhuang", [38.04, 114.51]],
  Heilongjiang: ["Harbin", [45.8, 126.53]],
  Henan: ["Zhengzhou", [34.75, 113.62]],
  Hubei: ["Wuhan", [30.59, 114.31]],
  Hunan: ["Changsha", [28.23, 112.94]],
  Jiangsu: ["Nanjing", [32.06, 118.8]],
  Jiangxi: ["Nanchang", [28.68, 115.86]],
  Jilin: ["Changchun", [43.82, 125.32]],
  Liaoning: ["Shenyang", [41.81, 123.43]],
  Qinghai: ["Xining", [36.62, 101.78]],
  Shaanxi: ["Xi'an", [34.34, 108.94]],
  Shandong: ["Jinan", [36.65, 117.12]],
  Shanxi: ["Taiyuan", [37.87, 112.55]],
  Sichuan: ["Chengdu", [30.57, 104.07]],
  Yunnan: ["Kunming", [25.04, 102.71]],
  Zhejiang: ["Hangzhou", [30.27, 120.16]],
  Taiwan: ["Taipei", [25.03, 121.57]],
  Guangxi: ["Nanning", [22.82, 108.32]],
  "Inner Mongolia": ["Hohhot", [40.84, 111.75]],
  Ningxia: ["Yinchuan", [38.49, 106.23]],
  Tibet: ["Lhasa", [29.65, 91.13]],
  Xinjiang: ["Ürümqi", [43.83, 87.62]],
};

// Chinese name (simplified characters) and Hanyu Pinyin with tone marks,
// keyed by the English name. The displayed name becomes
// "Guangdong (广东, Guǎngdōng)"; the plain English name, the pinyin and
// the characters are all kept as `aliases`, so a typed answer of any of
// them is accepted (attributes.js's name checkAnswer).
const ZH = {
  Anhui: ["安徽", "Ānhuī"],
  Beijing: ["北京", "Běijīng"],
  Chongqing: ["重庆", "Chóngqìng"],
  Fujian: ["福建", "Fújiàn"],
  Gansu: ["甘肃", "Gānsù"],
  Guangdong: ["广东", "Guǎngdōng"],
  Guangxi: ["广西", "Guǎngxī"],
  Guizhou: ["贵州", "Guìzhōu"],
  Hainan: ["海南", "Hǎinán"],
  Hebei: ["河北", "Héběi"],
  Heilongjiang: ["黑龙江", "Hēilóngjiāng"],
  Henan: ["河南", "Hénán"],
  "Hong Kong": ["香港", "Xiānggǎng"],
  Hubei: ["湖北", "Húběi"],
  Hunan: ["湖南", "Húnán"],
  "Inner Mongolia": ["内蒙古", "Nèi Měnggǔ"],
  Jiangsu: ["江苏", "Jiāngsū"],
  Jiangxi: ["江西", "Jiāngxī"],
  Jilin: ["吉林", "Jílín"],
  Liaoning: ["辽宁", "Liáoníng"],
  Macau: ["澳门", "Àomén"],
  Ningxia: ["宁夏", "Níngxià"],
  Qinghai: ["青海", "Qīnghǎi"],
  Shaanxi: ["陕西", "Shǎnxī"],
  Shandong: ["山东", "Shāndōng"],
  Shanghai: ["上海", "Shànghǎi"],
  Shanxi: ["山西", "Shānxī"],
  Sichuan: ["四川", "Sìchuān"],
  Taiwan: ["台湾", "Táiwān"],
  Tianjin: ["天津", "Tiānjīn"],
  Tibet: ["西藏", "Xīzàng"],
  Xinjiang: ["新疆", "Xīnjiāng"],
  Yunnan: ["云南", "Yúnnán"],
  Zhejiang: ["浙江", "Zhèjiāng"],
};

const TYPE = {
  Province: "Province",
  "Autonomous Region": "Autonomous Region",
  Municipality: "Municipality",
};

// Group source features into output divisions.
const groups = new Map(); // id -> { name, type, features[] }
function add(id, name, type, f) {
  if (!groups.has(id)) groups.set(id, { name, type, features: [] });
  groups.get(id).features.push(f);
}
for (const f of src.features) {
  const p = f.properties;
  if (p.adm0_a3 === "CHN") {
    if (!p.iso_3166_2?.startsWith("CN-") || p.iso_3166_2.includes("~")) continue; // Paracel Islands (CN-X01~)
    const type = TYPE[p.type_en];
    if (!type) throw new Error(`Unexpected CHN type ${p.type_en} for ${p.name_en}`);
    add(p.iso_3166_2, p.name_en, type, f);
  } else if (p.adm0_a3 === "TWN") {
    add("TW", "Taiwan", "Province", f);
  } else if (p.adm0_a3 === "HKG") {
    add("HK", "Hong Kong", "Special Administrative Region", f);
  } else if (p.adm0_a3 === "MAC") {
    add("MO", "Macau", "Special Administrative Region", f);
  }
}

// One topology over every source polygon, then merge each group's
// polygons into a single geometry (merge() also dissolves the internal
// county/district borders of Taiwan and Hong Kong).
const parts = [];
for (const [id, g] of groups) for (const f of g.features) parts.push({ type: "Feature", properties: { gid: id }, geometry: f.geometry });
const raw = topology({ parts: { type: "FeatureCollection", features: parts } }, 1e6);
const geoms = raw.objects.parts.geometries;
const merged = [];
for (const [id, g] of groups) {
  const mine = geoms.filter((x) => x.properties.gid === id);
  merged.push({ type: "Feature", id, geometry: merge(raw, mine) });
}

// Final topology: simplify to keep the file small (10m detail is far more
// than a quiz map needs), then quantize.
// Built unquantized so presimplify's point weights can be edited directly,
// then quantized at the end.
let topo = topology({ provinces: { type: "FeatureCollection", features: merged } });
topo = presimplify(topo);
// Simplification drops the lowest-weight points first, and a tiny
// division is *entirely* low-weight detail: a global threshold collapsed
// Macau into two 4-point zero-area slivers — no fill, no tap-assist hull,
// effectively unclickable. Pin every point of the SARs' arcs so they keep
// their full Natural Earth outline (only a few hundred points).
const KEEP_FULL_DETAIL = new Set(["HK", "MO"]);
const arcIndices = (arcs, out) => {
  for (const a of arcs) Array.isArray(a) ? arcIndices(a, out) : out.add(a < 0 ? ~a : a);
  return out;
};
for (const g of topo.objects.provinces.geometries) {
  if (!KEEP_FULL_DETAIL.has(g.id)) continue;
  for (const i of arcIndices(g.arcs, new Set())) for (const pt of topo.arcs[i]) pt[2] = Infinity;
}
topo = simplify(topo, quantile(topo, 0.08));
topo = quantize(topo, 1e5);
for (const g of topo.objects.provinces.geometries) delete g.properties;

const items = [...groups.entries()]
  .map(([id, g]) => {
    const cap = CAPITALS[g.name];
    if (g.type !== "Municipality" && g.type !== "Special Administrative Region" && !cap) {
      throw new Error(`No capital for ${g.name}`);
    }
    const zh = ZH[g.name];
    if (!zh) throw new Error(`No Chinese name for ${g.name}`);
    const [hanzi, pinyin] = zh;
    return {
      id,
      name: `${g.name} (${hanzi}, ${pinyin})`,
      nameEn: g.name,
      nameZh: hanzi,
      pinyin,
      aliases: [g.name, pinyin, hanzi],
      type: g.type,
      capital: cap ? cap[0] : null,
      capitalLatLng: cap ? cap[1] : null,
    };
  })
  .sort((a, b) => a.nameEn.localeCompare(b.nameEn));

// Sanity: 34 divisions, each with real area, each capital inside its own
// division.
if (items.length !== 34) throw new Error(`Expected 34 divisions, got ${items.length}`);
const fc = feature(topo, topo.objects.provinces);
const { geoContains, geoArea } = await import("d3-geo");
for (const f of fc.features) {
  if (!(geoArea(f) > 0)) throw new Error(`Division ${f.id} collapsed to zero area`);
}
for (const it of items) {
  if (!it.capitalLatLng) continue;
  const f = fc.features.find((x) => x.id === it.id);
  if (!geoContains(f, [it.capitalLatLng[1], it.capitalLatLng[0]])) {
    throw new Error(`Capital ${it.capital} not inside ${it.name}`);
  }
}

writeFileSync(path.join(outDir, "china.json"), JSON.stringify(items, null, 2) + "\n");
writeFileSync(path.join(outDir, "china-topology.json"), JSON.stringify(topo));
const counts = items.reduce((m, i) => ((m[i.type] = (m[i.type] ?? 0) + 1), m), {});
console.log(`Wrote ${items.length} divisions:`, counts);
