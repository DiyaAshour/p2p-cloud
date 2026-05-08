const fs = require('node:fs');

const file = 'client/src/NativeP2PApp.tsx';
if (!fs.existsSync(file)) process.exit(0);
let s = fs.readFileSync(file, 'utf8');
const before = s;

function normalizeCopy(input) {
  return input
    .replace(/Choose\s*&\s*(Choose\s*&\s*)+Store files/g, 'Choose & Store files')
    .replace(/Choose\s*&\s*Choose\s*&\s*Store files/g, 'Choose & Store files')
    .replace(/Click\s+Choose\s*&\s*(Choose\s*&\s*)*Store files/g, 'Press Choose & Store files')
    .replace(/press\s+Choose\s*&\s*(Choose\s*&\s*)*Store files/gi, 'press Choose & Store files')
    .replace(/click\s+Choose\s*&\s*(Choose\s*&\s*)*Store files/gi, 'press Choose & Store files')
    .replace(/Click\s+Encrypt\s*&\s*Upload/g, 'Press Choose & Store files')
    .replace(/press\s+Encrypt\s*&\s*Upload/gi, 'press Choose & Store files')
    .replace(/click\s+Encrypt\s*&\s*Upload/gi, 'press Choose & Store files')
    .replace(/Encrypt\s*&\s*Upload/g, 'Choose & Store files')
    .replace(/Store files/g, 'Choose & Store files')
    .replace(/Choose\s*&\s*(Choose\s*&\s*)+Store files/g, 'Choose & Store files');
}

s = normalizeCopy(s);

// Native streaming upload selects files inside Electron, so the button must not require selectedFiles.length.
s = s.replace(/disabled=\{[^}]*!selectedFiles\.length[^}]*\}/g, 'disabled={!walletConnected || busy}');
s = s.replace(/disabled=\{!walletConnected \|\| busy \|\| uploadWouldExceedQuota\}/g, 'disabled={!walletConnected || busy}');

// Hard-fix the actual upload button regardless of prop order.
s = s.replace(/<Button([^>]*?)onClick=\{uploadFiles\}([^>]*?)disabled=\{[^}]*\}([^>]*?)>/g, '<Button$1onClick={uploadFiles}$2disabled={!walletConnected || busy}$3>');
s = s.replace(/<Button([^>]*?)disabled=\{[^}]*\}([^>]*?)onClick=\{uploadFiles\}([^>]*?)>/g, '<Button$1disabled={!walletConnected || busy}$2onClick={uploadFiles}$3>');

// Clear, idempotent commercial copy.
s = s.replace(/Large-file safe mode is enabled\. [^<]+/g, 'Large-file safe mode is enabled. Press Choose & Store files to select files with the native picker; files are streamed from disk instead of loaded into browser RAM.');
s = s.replace(/press .*? to choose files with native streaming/g, 'press Choose & Store files to choose files with native streaming');
s = s.replace(/click .*? to choose files with native streaming/g, 'press Choose & Store files to choose files with native streaming');
s = normalizeCopy(s);

if (s.includes('await file.arrayBuffer()')) {
  throw new Error('Unsafe browser RAM upload path still exists');
}

const uploadFnMatch = s.match(/const uploadFiles = \(\) => runBusy\(async \(\) => \{[\s\S]*?\n\s*const downloadFile = /);
if (!uploadFnMatch || !uploadFnMatch[0].includes('"p2p:uploadFiles"')) {
  throw new Error('Upload function is not using p2p:uploadFiles native streaming');
}

const buttonStillBlocked = /<Button[^>]*onClick=\{uploadFiles\}[^>]*disabled=\{[^}]*!selectedFiles\.length[^}]*\}/.test(s) || /<Button[^>]*disabled=\{[^}]*!selectedFiles\.length[^}]*\}[^>]*onClick=\{uploadFiles\}/.test(s);
if (buttonStillBlocked) {
  throw new Error('Upload button still requires selectedFiles.length');
}

if (s !== before) {
  fs.writeFileSync(file, s, 'utf8');
  console.log('[fix-native-upload-button] upload button now opens native picker without preselection');
} else {
  console.log('[fix-native-upload-button] no changes needed');
}
