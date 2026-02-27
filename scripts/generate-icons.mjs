import { createCanvas, loadImage } from 'canvas';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sizes = [16, 32, 48, 128];
const iconsDir = path.join(__dirname, '..', 'extension', 'icons');
const frogSvgPath = path.join(iconsDir, 'vibbit-frog.svg');
const frogGlowColour = '#4ADE80';

async function generateIcons() {
  const frogImage = await loadImage(frogSvgPath);

  for (const size of sizes) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    // Clear
    ctx.clearRect(0, 0, size, size);

    // Add a subtle glow effect for larger sizes
    if (size >= 32) {
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.shadowColor = frogGlowColour;
      ctx.shadowBlur = size * 0.2;
      ctx.drawImage(frogImage, 0, 0, size, size);
      ctx.restore();
    }

    ctx.drawImage(frogImage, 0, 0, size, size);

    // Save PNG
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), buffer);
    console.log(`Created icon${size}.png`);
  }

  console.log('All icons created!');
}

generateIcons().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
