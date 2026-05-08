const fs = require('node:fs');

function patchFile(file, mutator) {
  if (!fs.existsSync(file)) return false;
  const before = fs.readFileSync(file, 'utf8');
  const after = mutator(before);
  if (after !== before) {
    fs.writeFileSync(file, after, 'utf8');
    console.log(`[fix-commercial] patched ${file}`);
    return true;
  }
  console.log(`[fix-commercial] ok ${file}`);
  return false;
}

patchFile('client/src/NativeP2PApp.tsx', (source) => {
  let s = source;

  // React Rules of Hooks: do not return before useMemo/useEffect hooks.
  s = s.replace(/\n\s*if \(!bridge\) return <ElectronRequiredScreen \/>;\n/, '\n');
  if (!s.includes('const prepareProof') || !s.includes('if (!bridge) return <ElectronRequiredScreen />;\n\n  return <div')) {
    s = s.replace(
      /(const prepareProof = \(file: P2PFile\) => runBusy\(async \(\) => \{[\s\S]*?toast\.success\("Proof copied"\); \}\);)\n\n  return <div/,
      `$1\n\n  if (!bridge) return <ElectronRequiredScreen />;\n\n  return <div`
    );
  }

  // UI/backend password policy must match backend MIN_DRIVE_PASSWORD_LENGTH = 12.
  s = s.replace(/password\.length < 6/g, 'password.length < 12');
  s = s.replace(/Enter your Drive Password for encrypted files\./g, 'Enter your Drive Password for encrypted files. Use at least 12 characters.');
  s = s.replace(/Needed for encrypted upload\/download/g, 'Minimum 12 characters for encrypted upload/download');

  // Repair the known JSX typo left by previous patches.
  s = s.replace(/<Trash2 className="size-4" \/>Delete<\/Button>\}<\/div><select/g, '<Trash2 className="size-4" />Delete</Button></div><select');
  s = s.replace(/<Trash2 className="size-4" \/>Delete<\/Button>\}\s*<\/div><select/g, '<Trash2 className="size-4" />Delete</Button></div><select');

  return s;
});

patchFile('electron/main.js', (source) => {
  let s = source;

  // Safety peer must be best-effort. A central server outage must not kill P2P uploads.
  s = s.replace(
    /try \{\n\s*await putChunkToSafetyPeer\(chunkPayload, node\.peerId\);\n\s*replicas\.push\('aws-safety-peer'\);\n\s*\} catch \(error\) \{\n\s*throw new Error\(`Safety peer upload failed for chunk \$\{chunk\.hash\}: \$\{error\?\.message \|\| error\}`\);\n\s*\}/g,
    `try {\n        await putChunkToSafetyPeer(chunkPayload, node.peerId);\n        replicas.push('aws-safety-peer');\n      } catch (error) {\n        console.warn('[safety-peer] optional upload failed:', error?.message || error);\n      }`
  );

  s = s.replace(/const MIN_DRIVE_PASSWORD_LENGTH = Number\(process\.env\.P2P_MIN_DRIVE_PASSWORD_LENGTH \|\| 12\);/,
    'const MIN_DRIVE_PASSWORD_LENGTH = Number(process.env.P2P_MIN_DRIVE_PASSWORD_LENGTH || 12);');

  return s;
});

patchFile('electron/manifest-sync.js', (source) => {
  let s = source;
  s = s.replace("const DEFAULT_MANIFEST_SYNC_URL = 'http://54.166.171.208:8790';", "const DEFAULT_MANIFEST_SYNC_URL = ''; // Configure with P2P_MANIFEST_SYNC_URL when remote sync is wanted.");
  return s;
});

patchFile('electron/safety-peer.js', (source) => {
  let s = source;
  s = s.replace("const DEFAULT_SAFETY_PEER_URL = 'ws://54.166.171.208:8787';", "const DEFAULT_SAFETY_PEER_URL = ''; // Configure with P2P_SAFETY_PEER_URL when a safety peer is wanted.");
  return s;
});

console.log('[fix-commercial] critical issue patch complete');
