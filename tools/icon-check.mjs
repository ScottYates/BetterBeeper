// Dev helper: assert the self-coloured glyph mechanism behaves as designed.
import * as icons from '../src/renderer/js/network-icons.js';

let fails = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) fails += 1;
};

const gvBadge = icons.badgeBackground('Google Voice');
ok('Google Voice overrides the disc', gvBadge === '#111614', gvBadge);
ok('Google Voice has a glyph', icons.hasGlyph('Google Voice'));

for (const net of ['Signal', 'WhatsApp', 'Slack', 'Beeper', 'Discord']) {
  ok(`${net} keeps the brand disc`, icons.badgeBackground(net) === '');
}

const gv = icons.networkIconMarkup('Google Voice', { size: 11 });
ok('mark carries a gradient', gv.includes('linearGradient'));
ok('no currentColor left', !gv.includes('currentColor'));
ok('all paint is the gradient', !/fill="(?!none|url)/.test(gv) && !/stroke="(?!none|url)/.test(gv));
ok('viewBox and size set', gv.includes('viewBox="0 0 16 16"') && gv.includes('width="11"'));

// Two badges in the same document must not collide on the gradient id.
const a = icons.networkIconMarkup('Google Voice');
const b = icons.networkIconMarkup('Google Voice');
const idA = a.match(/id="([^"]+)"/)[1];
const idB = b.match(/id="([^"]+)"/)[1];
ok('gradient ids are unique per instance', idA !== idB, `${idA} vs ${idB}`);
ok('both ids are referenced', a.includes(`url(#${idA})`) && b.includes(`url(#${idB})`));

// Every other mark must be untouched by the refactor.
for (const net of ['Signal', 'WhatsApp', 'Telegram', 'Gmail', 'Discord', 'Pinterest']) {
  const svg = icons.networkIconMarkup(net);
  ok(`${net} still renders a mark`, svg.length > 40 && svg.includes('currentColor'));
}

const unknown = icons.networkIconMarkup('Some Unknown Net');
ok('unknown network still falls back', unknown === '');

console.log(`\n${fails ? '✗' : '✓'} ${fails ? fails + ' failed' : 'all checks passed'}`);
process.exit(fails ? 1 : 0);
