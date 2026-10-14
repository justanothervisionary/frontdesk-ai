// One-time, local, not deployed: migrates every configs/*.json from the
// old faqs[]/businessInfo shape to the new unified chunks[] shape. Run
// once (`node tools/migrate-chunks.js`), commit the migrated config files
// alongside the code change that introduces `chunks` - there is no
// permanent dual-shape compatibility code anywhere else in this codebase,
// so this must ship in the same deploy as the rest of the chunks feature,
// not after it.
const fs = require("fs");
const path = require("path");
const CONFIGS_DIR = path.join(__dirname, "..", "configs");

function inferCategory(keywords) {
  var kw = (keywords || []).map(function (k) { return k.toLowerCase(); });
  if (kw.some(function (k) { return /price|cost|fee|quote/.test(k); })) return "Pricing";
  if (kw.some(function (k) { return /book|appointment|callout|viewing|available/.test(k); })) return "Booking";
  if (kw.some(function (k) { return /hour|open|close|time/.test(k); })) return "General";
  return "FAQ"; // default - every pre-migration faqs[] entry was implicitly answering some question
}

fs.readdirSync(CONFIGS_DIR).filter(function (f) { return f.endsWith(".json"); }).forEach(function (file) {
  var full = path.join(CONFIGS_DIR, file);
  var config = JSON.parse(fs.readFileSync(full, "utf8"));
  var chunks = [];
  if (config.businessInfo) chunks.push({ category: "General", text: config.businessInfo.toString().trim().slice(0, 1200) });
  (config.faqs || []).forEach(function (f) {
    var text = ((f && f.answer) || "").toString().trim();
    if (text) chunks.push({ category: inferCategory(f.keywords), text: text.slice(0, 1200) });
  });
  config.chunks = chunks.slice(0, 12);
  delete config.faqs;
  delete config.businessInfo;
  fs.writeFileSync(full, JSON.stringify(config, null, 2) + "\n");
  console.log("Migrated", file, "->", config.chunks.length, "chunks");
});
