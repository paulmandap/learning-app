/**
 * Nomi (body, eyes, wings) wearing a hat at candidate places, side by side
 * (NOTES §72.5) — the way §68 chose the last nightcap's place.
 *
 *   npx tsx scripts/try-nightcap.ts '[{"label":"A","cx":0.635,"cy":0.206,"width":1.2,"rotate":-3}]'
 *
 * A place is `PROP_PLACES`' own numbers; `"old": true` draws the striped hat in
 * assets/ instead of design-reference/nightcap-cut.png. Writes
 * design-reference/nightcap-tryout.png at half size.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { openCanvasPage } from './chrome-canvas';

const A = 'assets';
const S = 'design-reference';
const uri = (path: string, type: string) => `data:${type};base64,${readFileSync(path).toString('base64')}`;

async function main() {
  const places = JSON.parse(process.argv[2]!) as { label: string; cx: number; cy: number; width: number; rotate: number; old?: boolean }[];
  const layers = {
    body: uri(`${A}/nomi-body.webp`, 'image/webp'),
    eyeL: uri(`${A}/nomi-eye-left.webp`, 'image/webp'),
    eyeR: uri(`${A}/nomi-eye-right.webp`, 'image/webp'),
    wingL: uri(`${A}/nomi-wing-left.webp`, 'image/webp'),
    wingR: uri(`${A}/nomi-wing-right.webp`, 'image/webp'),
    oldHat: uri(`${A}/nomi-prop-nightcap.webp`, 'image/webp'),
    newHat: uri(`${S}/nightcap-cut.png`, 'image/png'),
  };
  const page = await openCanvasPage('try-hat');
  try {
    const out = await page.evaluate<string>(`(async () => {
      const L = ${JSON.stringify(layers)};
      const P = ${JSON.stringify(places)};
      const img = {};
      for (const k of Object.keys(L)) { const i = new Image(); i.src = L[k]; await i.decode(); img[k] = i; }
      const W = 367, H = 493, pad = 140, cellW = W + pad * 2, cellH = H + pad + 40;
      const c = document.createElement('canvas'); c.width = cellW * P.length; c.height = cellH;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#1b2328'; ctx.fillRect(0, 0, c.width, c.height);
      P.forEach((p, n) => {
        const ox = n * cellW + pad, oy = pad;
        for (const k of ['body', 'eyeL', 'eyeR', 'wingL', 'wingR']) ctx.drawImage(img[k], ox, oy, W, H);
        const hat = p.old ? img.oldHat : img.newHat;
        const w = p.width * W, h = w * hat.naturalHeight / hat.naturalWidth;
        ctx.save();
        ctx.translate(ox + p.cx * W, oy + p.cy * H);
        ctx.rotate(p.rotate * Math.PI / 180);
        ctx.drawImage(hat, -w / 2, -h / 2, w, h);
        ctx.restore();
        ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.strokeRect(ox, oy, W, H);
        ctx.fillStyle = '#fff'; ctx.font = '22px sans-serif';
        ctx.fillText(p.label, n * cellW + 12, cellH - 14);
      });
      const small = document.createElement('canvas'); small.width = c.width / 2; small.height = c.height / 2;
      small.getContext('2d').drawImage(c, 0, 0, small.width, small.height);
      return small.toDataURL('image/png');
    })()`);
    writeFileSync(`${S}/nightcap-tryout.png`, Buffer.from(out.split(',')[1]!, 'base64'));
    console.log('wrote design-reference/nightcap-tryout.png');
  } finally {
    await page.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
