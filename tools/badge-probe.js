// Dev helper: prove the network badge is a true circle for a glyph, and a pill
// for a monogram fallback. Run against the dev app, which has #zoom-probe up.
(async () => {
  const m = await import('../src/renderer/js/sidebar.js');
  const host = document.getElementById('zoom-probe') || document.body;

  const make = (badge) => {
    const wrap = document.createElement('div');
    wrap.className = 'avatar-wrap';
    const av = document.createElement('div');
    av.className = 'avatar';
    av.style.width = '38px';
    av.style.height = '38px';
    av.style.background = '#555';
    wrap.append(av, badge);
    return wrap;
  };

  const cases = [
    ['glyph', m.networkBadge({ network: 'Google Voice' })],
    ['glyph', m.networkBadge({ network: 'Signal' })],
    ['monogram', m.networkBadge({ network: 'Some Brand New Net' })],
  ];

  const box = document.createElement('div');
  box.id = 'badge-probe';
  box.style.cssText =
    'position:absolute;top:8px;left:600px;display:flex;gap:28px;align-items:center;'
    + 'background:#0d0d0f;padding:14px;border-radius:12px';
  const out = {};
  for (const [kind, badge] of cases) {
    box.append(make(badge));
    const r = badge.getBoundingClientRect();
    out[`${kind}:${badge.textContent || badge.dataset.net}`] = {
      cls: badge.className,
      w: Math.round(r.width),
      h: Math.round(r.height),
      round: Math.round(r.width) === Math.round(r.height),
    };
  }
  host.append(box);
  return JSON.stringify(out, null, 1);
})()
