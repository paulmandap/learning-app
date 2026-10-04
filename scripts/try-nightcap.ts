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
      // Gaps: the owl's pixels that show between parts of the hat — under a part
      // of it in the same column, or above its top. A tuft poking out between
      // the cuff and the hanging tip is the first kind (the owner, 2026-10-04).
      const gaps = P.map((p) => {
        const b = document.createElement('canvas'); b.width = W; b.height = H;
        b.getContext('2d').drawImage(img.body, 0, 0, W, H);
        const hc = document.createElement('canvas'); hc.width = W; hc.height = H;
        const hx = hc.getContext('2d');
        const hat = p.old ? img.oldHat : img.newHat;
        const w = p.width * W, h = w * hat.naturalHeight / hat.naturalWidth;
        hx.translate(p.cx * W, p.cy * H); hx.rotate(p.rotate * Math.PI / 180); hx.drawImage(hat, -w / 2, -h / 2, w, h);
        const bd = b.getContext('2d').getImageData(0, 0, W, H).data, hd = hx.getImageData(0, 0, W, H).data;
        let between = 0, above = 0;
        for (let x = 0; x < W; x++) {
          let top = -1, bottom = -1;
          for (let y = 0; y < H; y++) if (hd[(y * W + x) * 4 + 3] > 128) { if (top < 0) top = y; bottom = y; }
          if (top < 0) continue;
          for (let y = 0; y < bottom; y++) {
            const i = (y * W + x) * 4;
            if (bd[i + 3] > 128 && hd[i + 3] <= 128) { if (y < top) above++; else between++; }
          }
        }
        return p.label + ': ' + between + ' between, ' + above + ' above';
      });
      const report = gaps.join(' | ');
      // ZOOM: just the head of each, full size — to check an ear tuft by eye.
      if (${process.env.ZOOM === '1'}) {
        const z = document.createElement('canvas'); const zw = 300, zh = 260;
        z.width = zw * P.length; z.height = zh;
        const zc = z.getContext('2d');
        P.forEach((p, n) => zc.drawImage(c, n * cellW + pad + W * 0.35, pad - H * 0.2, zw, zh, n * zw, 0, zw, zh));
        return JSON.stringify({ report, png: z.toDataURL('image/png') });
      }
      const small = document.createElement('canvas'); small.width = c.width / 2; small.height = c.height / 2;
      small.getContext('2d').drawImage(c, 0, 0, small.width, small.height);
      return JSON.stringify({ report, png: small.toDataURL('image/png') });
    })()`);
    const { report, png } = JSON.parse(out) as { report: string; png: string };
    console.log(report);
    writeFileSync(`${S}/nightcap-tryout.png`, Buffer.from(png.split(',')[1]!, 'base64'));
    console.log('wrote design-reference/nightcap-tryout.png');
  } finally {
    await page.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
