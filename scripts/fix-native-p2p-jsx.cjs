const fs = require('node:fs');

const file = 'client/src/NativeP2PApp.tsx';
let src = fs.readFileSync(file, 'utf8');
const before = src;

src = src.replace(
  '{visibleFiles.map((file) => <Card ',
  '{visibleFiles.map((file) => (<Card '
);

src = src.replace(
  '</Card>)}</div>{visibleFiles.length === 0 &&',
  '</Card>))}</div>{visibleFiles.length === 0 &&'
);

if (src === before) {
  console.log('No JSX map patch needed. File already looks patched.');
} else {
  fs.writeFileSync(file, src, 'utf8');
  console.log('Patched NativeP2PApp files grid JSX.');
}
