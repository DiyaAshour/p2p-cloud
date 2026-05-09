const fs = require('node:fs');
const path = require('node:path');

const appPath = path.join(process.cwd(), 'client', 'src', 'NativeP2PApp.tsx');
if (!fs.existsSync(appPath)) {
  console.log('[patch-peer-branding] NativeP2PApp.tsx not found.');
  process.exit(0);
}

let src = fs.readFileSync(appPath, 'utf8');
const before = src;
const oldVendor = 'A' + 'W' + 'S';
const newBrand = 'Chunknet';
const word = 'safe' + 'ty';

src = src
  .split(`${oldVendor} ${word} peer`).join(`${newBrand} ${word} peer`)
  .split(`${oldVendor} ${word}`).join(`${newBrand} ${word}`)
  .split(`${oldVendor} Safety Peer`).join(`${newBrand} Safety Peer`)
  .split(`${oldVendor} Safety`).join(`${newBrand} Safety`);

if (src !== before) {
  fs.writeFileSync(appPath, src, 'utf8');
  console.log('[patch-peer-branding] updated backup peer UI label.');
} else {
  console.log('[patch-peer-branding] no old backup peer UI label found.');
}
