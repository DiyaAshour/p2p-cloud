const fs = require('node:fs');

const file = 'client/src/NativeP2PApp.tsx';
if (!fs.existsSync(file)) process.exit(0);
let s = fs.readFileSync(file, 'utf8');
const before = s;

// Normalize repeated wording caused by older non-idempotent patches.
s = s.replace(/Choose\s*&\s*(Choose\s*&\s*)+Store files/g, 'Choose & Store files');
s = s.replace(/Choose\s*&\s*Choose\s*&\s*Store files/g, 'Choose & Store files');
s = s.replace(/Click\s+Choose\s*&\s*(Choose\s*&\s*)*Store files/g, 'Press Choose & Store files');
s = s.replace(/press\s+Choose\s*&\s*(Choose\s*&\s*)*Store files/gi, 'press Choose & Store files');

// Native streaming upload selects files inside Electron, so the button must not require selectedFiles.length.
s = s.replace(/disabled=\{[^}]*!selectedFiles\.length[^}]*\}/g, 'disabled={!walletConnected || busy}');
s = s.replace(/disabled=\{!walletConnected \|\| busy \|\| uploadWouldExceedQuota\}/g, 'disabled={!walletConnected || busy}');

// Clear, idempotent commercial copy.
s = s.replace(/Large-file safe mode is enabled\. [^<]+/g, 'Large-file safe mode is enabled. Press Choose & Store files to select files with the native picker; files are streamed from disk instead of loaded into browser RAM.');
s = s.replace(/press .*? to choose files with native streaming/g, 'press Choose & Store files to choose files with native streaming');
s = s.replace(/click .*? to choose files with native streaming/g, 'press Choose & Store files to choose files with native streaming');
s = s.replace(/Store files/g, 'Choose & Store files');
s = s.replace(/Choose\s*&\s*(Choose\s*&\s*)+Store files/g, 'Choose & Store files');

if (s.includes('await file.arrayBuffer()')) {
  throw new Error('Unsafe browser RAM upload path still exists');
}

const uploadFnMatch = s.match(/const uploadFiles = \(\) => runBusy\(async \(\) => \{[\s\S]*?\n\s*const downloadFile = /);
if (!uploadFnMatch || !uploadFnMatch[0].includes('"p2p:uploadFiles"')) {
  throw new Error('Upload function is not using p2p:uploadFiles native streaming');
}

const buttonStillBlocked = /disabled=\{[^}]*!selectedFiles\.length[^}]*\}/.test(s);
if (buttonStillBlocked) {
  throw new Error('Upload button still requires selectedFiles.length');
}

if (s !== before) {
  fs.writeFileSync(file, s, 'utf8');
  console.log('[fix-native-upload-button] upload button now opens native picker without preselection');
} else {
  console.log('[fix-native-upload-button] no changes needed');
}
