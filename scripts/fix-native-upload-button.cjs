const fs = require('node:fs');

const file = 'client/src/NativeP2PApp.tsx';
if (!fs.existsSync(file)) process.exit(0);
let s = fs.readFileSync(file, 'utf8');
const before = s;

s = s.replaceAll('disabled={!walletConnected || busy || !selectedFiles.length || uploadWouldExceedQuota}', 'disabled={!walletConnected || busy}');
s = s.replaceAll('disabled={!walletConnected || busy || !selectedFiles.length}', 'disabled={!walletConnected || busy}');
s = s.replaceAll('disabled={!walletConnected || busy || uploadWouldExceedQuota}', 'disabled={!walletConnected || busy}');
s = s.replaceAll('Store files', 'Choose & Store files');
s = s.replaceAll('Encrypt & Upload', 'Choose & Store files');
s = s.replaceAll('Click Encrypt & Upload', 'Press Choose & Store files');
s = s.replaceAll('press Encrypt & Upload', 'press Choose & Store files');
s = s.replaceAll('click Encrypt & Upload', 'press Choose & Store files');

if (s.includes('await file.arrayBuffer()')) {
  throw new Error('Unsafe browser RAM upload path still exists');
}
if (s.includes('!selectedFiles.length')) {
  throw new Error('Upload button still requires selectedFiles.length');
}

if (s !== before) {
  fs.writeFileSync(file, s, 'utf8');
  console.log('[fix-native-upload-button] upload button now opens native picker without preselection');
} else {
  console.log('[fix-native-upload-button] no changes needed');
}
