/**
 * Dev helper: does restoreBounds() really clamp a too-small saved size?
 * Rewrites windowBounds in settings.json, restarts nothing, and prints the
 * current viewport so a relaunch can be compared against it.
 * Usage: node tools/probe-bounds.js <width> <height> [x] [y]
 */
const fs = require('fs');
const path = require('path');

const settingsPath = path.join(
  process.env.APPDATA || '',
  'Better Beeper',
  'settings.json',
);

const [w, h, x, y] = process.argv.slice(2).map((v) => (v == null ? undefined : Number(v)));
if (!Number.isFinite(w) || !Number.isFinite(h)) {
  console.error('usage: node tools/probe-bounds.js <width> <height> [x] [y]');
  process.exit(1);
}

const raw = fs.readFileSync(settingsPath, 'utf8');
const parsed = JSON.parse(raw);
parsed.windowBounds = { x: x ?? parsed.windowBounds?.x ?? 0, y: y ?? parsed.windowBounds?.y ?? 0, width: w, height: h };
fs.writeFileSync(settingsPath, JSON.stringify(parsed, null, 2));
console.log('wrote windowBounds:', JSON.stringify(parsed.windowBounds));
