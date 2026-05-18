const fs = require('node:fs');
const path = require('node:path');

const livePath = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');

if (!fs.existsSync(livePath)) {
  console.warn('[folder-panel-shell] NativeP2PAppLive.tsx not found');
  process.exit(0);
}

let src = fs.readFileSync(livePath, 'utf8');
const before = src;

const looksComplete =
  src.includes('export default function NativeP2PAppLive') &&
  src.includes('<main className=') &&
  src.includes('</main>') &&
  src.includes('TabsContent value="admin"') &&
  src.length > 30000;

if (!looksComplete) {
  console.warn('[folder-panel-shell] NativeP2PAppLive.tsx is incomplete; not patching shell. Restore the complete file first.');
  process.exit(0);
}

function ensureIdentityContract(source) {
  const identityBlock = [
    '  const walletConnected = Boolean(wallet?.connected && wallet?.authMode !== "seed" && (wallet.accountId || wallet.address));',
    '  const seedConnected = Boolean(wallet?.connected && wallet?.authMode === "seed" && (wallet.accountId || wallet.username || wallet.seedFingerprint));',
    '  const identityConnected = Boolean(walletConnected || seedConnected);',
    '  const identityLabel = seedConnected ? `Seed: ${wallet?.username || short(wallet?.accountId || wallet?.address || "")}` : walletConnected ? short(wallet?.address || wallet?.accountId || "") : "Guest";',
  ].join('\n');

  const blockPattern = /  const walletConnected = Boolean\([^\n]+\);\r?\n(?:  const seedConnected = Boolean\([^\n]+\);\r?\n)?(?:  const identityConnected = Boolean\([^\n]+\);\r?\n)?  const identityLabel = [^\n]+;\r?\n/;
  if (blockPattern.test(source)) {
    return source.replace(blockPattern, identityBlock + '\n');
  }

  if (source.includes('identityConnected') && !source.includes('const identityConnected = Boolean(walletConnected || seedConnected);')) {
    const walletLine = /  const walletConnected = Boolean\([^\n]+\);\r?\n/;
    if (walletLine.test(source)) return source.replace(walletLine, identityBlock + '\n');
  }

  return source;
}

src = ensureIdentityContract(src);

if (!src.includes('import ManifestFolderPanel from "./ManifestFolderPanel";')) {
  src = src.replace('import { toast } from "sonner";', 'import { toast } from "sonner";\nimport ManifestFolderPanel from "./ManifestFolderPanel";');
}

const oldFoldersCard = /          <Card className="rounded-2xl border-zinc-800 bg-zinc-900">\r?\n            <CardHeader><CardTitle className="text-base">Folders<\/CardTitle><\/CardHeader>\r?\n            <CardContent className="space-y-3">\r?\n              <div className="flex gap-2"><Input value=\{newFolder\} onChange=\{\(event\) => setNewFolder\(event\.target\.value\)\} placeholder="New folder" \/><Button onClick=\{createFolder\}>\+<\/Button><\/div>\r?\n              \{folders\.map\(\(folder\) => \(\r?\n                <button key=\{folder\} onClick=\{\(\) => setActiveFolder\(folder\)\} className=\{`block w-full rounded-xl px-4 py-3 text-left text-sm \$\{activeFolder === folder \? "bg-zinc-800" : "text-zinc-400 hover:bg-zinc-800\/60"\}`\}>\r?\n                  <FolderOpen className="mr-2 inline size-4" \/>\{folder\}\r?\n                <\/button>\r?\n              \)\)\}\r?\n            <\/CardContent>\r?\n          <\/Card>/;

const replacement = '          <ManifestFolderPanel api={api} busy={busy} enabled={view === "personal"} activeFolderName={activeFolder} onRefresh={refresh} onSelectFolder={(folder) => setActiveFolder(folder?.name || ALL_FILES)} />';

if (!src.includes('<ManifestFolderPanel api={api}')) {
  const next = src.replace(oldFoldersCard, replacement);
  if (next === src) {
    console.warn('[folder-panel-shell] Folders card marker not found; shell not mounted');
  } else {
    src = next;
  }
} else if (!src.includes('activeFolderName={activeFolder}')) {
  src = src.replace(
    /<ManifestFolderPanel api=\{api\} busy=\{busy\} enabled=\{view === "personal"\}([^>]*)\/>/,
    '<ManifestFolderPanel api={api} busy={busy} enabled={view === "personal"} activeFolderName={activeFolder}$1/>'
  );
}

if (src.includes('identityConnected') && !src.includes('const identityConnected = Boolean(walletConnected || seedConnected);')) {
  console.warn('[folder-panel-shell] warning: identityConnected is referenced without definition');
}

if (src !== before) {
  fs.writeFileSync(livePath, src, 'utf8');
  console.log('[folder-panel-shell] mounted isolated ManifestFolderPanel, active folder bridge, and identity contract');
} else {
  console.log('[folder-panel-shell] already mounted and identity contract is valid');
}
