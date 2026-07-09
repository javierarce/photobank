import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// Renders the editable design source (build/icon.svg) into the 1024px PNG
// master that `tauri icon` consumes (see the `icons` npm script). If the icon
// is ever redesigned in a tool whose SVG features librsvg renders poorly,
// export build/icon.png from the design tool instead and drop the SVG step.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const svg = resolve(root, "build/icon.svg");
const master = resolve(root, "build/icon.png");

await sharp(svg, { density: 300 })
  .resize(1024, 1024)
  .png({ compressionLevel: 9 })
  .toFile(master);

console.log("wrote build/icon.png (1024x1024)");
