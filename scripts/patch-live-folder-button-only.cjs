const fs = require('node:fs');
const file = 'client/src/NativeP2PAppLive.tsx';
let s = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
let changed = false;

function rep(a, b) {
  if (s.includes(a)) {
    s = s.replace(a, b);
    changed = true;
  }
}

rep(
  '<Button onClick={createFolder}>+</Button>',
  '<Button type="button" onClick={(event) => { event.preventDefault(); console.log("[folders] plus clicked", newFolder); createFolder(); }}>+</Button>'
);

rep(
  '<Button onClick={createFolder} disabled={busy}>+</Button>',
  '<Button type="button" onClick={(event) => { event.preventDefault(); console.log("[folders] plus clicked", newFolder); createFolder(); }}>+</Button>'
);

if (!s.includes('[folders] plus clicked')) {
  console.error('[patch-live-folder-button-only] failed to patch plus button');
  process.exit(1);
}

fs.writeFileSync(file, s, 'utf8');
console.log(changed ? '[patch-live-folder-button-only] patched plus button' : '[patch-live-folder-button-only] already applied');
