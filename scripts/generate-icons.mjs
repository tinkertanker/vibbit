import { createCanvas } from 'canvas';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sizes = [16, 32, 48, 128];
const iconsDir = path.join(__dirname, '..', 'extension', 'icons');

// Create sparkle icon as PNG
sizes.forEach(size => {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Clear
  ctx.clearRect(0, 0, size, size);

  // Draw a sparkle/star shape - like the GitHub sparkles or similar AI icons
  const cx = size / 2;
  const cy = size / 2;
  const outerRadius = size * 0.45;
  const innerRadius = size * 0.15;
  const points = 4; // 4-pointed star

  // Fill colour - a nice blue/purple gradient feel
  ctx.fillStyle = '#6366f1'; // Indigo-500

  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const radius = i % 2 === 0 ? outerRadius : innerRadius;
    const angle = (i * Math.PI) / points - Math.PI / 2;
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.closePath();
  ctx.fill();

  // Add a subtle glow effect for larger sizes
  if (size >= 32) {
    ctx.globalAlpha = 0.3;
    ctx.shadowColor = '#818cf8';
    ctx.shadowBlur = size * 0.2;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  // Save PNG
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), buffer);
  console.log(`Created icon${size}.png`);
});

console.log('All icons created!');
