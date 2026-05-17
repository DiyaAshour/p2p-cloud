const fs = require('node:fs');

const p = 'client/src/NativeP2PAppLive.tsx';
let s = fs.readFileSync(p, 'utf8');
let changed = false;

function r(from, to) {
  if (s.includes(from)) {
    s = s.replace(from, to);
    changed = true;
  }
}

function done() {
  if (changed) {
    fs.writeFileSync(p, s, 'utf8');
    console.log('[patch-live-folder-actions] applied');
  } else {
    console.log('[patch-live-folder-actions] already applied');
  }
}

// Part 1 scaffold. Further patches add folder parent state and actions.
done();
