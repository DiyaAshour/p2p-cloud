const fs = require('node:fs');

const files = [
  'client/src/NativeP2PApp.tsx',
  'client/src/DriveP2PAppPassword.tsx',
];

let changed = false;

for (const file of files) {
  if (!fs.existsSync(file)) continue;
  let s = fs.readFileSync(file, 'utf8');
  const before = s;

  // Some legacy UI patch combinations can leave an extra literal JSX brace after
  // a conditional delete button, producing: Delete</Button>}</div><select ...
  // That brace is not part of a JSX expression and breaks Vite/esbuild.
  s = s.replace(/(<Trash2 className="size-4"\s*\/>Delete<\/Button>)\}<\/div><select/g, '$1</div><select');
  s = s.replace(/(Delete<\/Button>)\}<\/div><select/g, '$1</div><select');

  // More general cleanup for the same generated shape with whitespace/newlines.
  s = s.replace(/(<\/Button>)\s*\}\s*(<\/div>\s*<select\b)/g, '$1$2');

  if (s !== before) {
    fs.writeFileSync(file, s, 'utf8');
    changed = true;
    console.log(`[fix-generated-jsx-syntax] fixed JSX syntax in ${file}`);
  }
}

console.log(changed ? '[fix-generated-jsx-syntax] JSX cleanup applied' : '[fix-generated-jsx-syntax] no JSX cleanup needed');
