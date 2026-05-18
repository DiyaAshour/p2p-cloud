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

if (!src.includes('import ManifestFolderPanel from "./ManifestFolderPanel";')) {
  src = src.replace('import { toast } from "sonner";', 'import { toast } from "sonner";\nimport ManifestFolderPanel from "./ManifestFolderPanel";');
}

const oldFoldersCard = /          <Card className="rounded-2xl border-zinc-800 bg-zinc-900">\r?\n            <CardHeader><CardTitle className="text-base">Folders<\/CardTitle><\/CardHeader>\r?\n            <CardContent className="space-y-3">\r?\n              <div className="flex gap-2"><Input value=\{newFolder\} onChange=\{\(event\) => setNewFolder\(event\.target\.value\)\} placeholder="New folder" \/><Button onClick=\{createFolder\}>\+<\/Button><\/div>\r?\n              \{folders\.map\(\(folder\) => \(\r?\n                <button key=\{folder\} onClick=\{\(\) => setActiveFolder\(folder\)\} className=\{`block w-full rounded-xl px-4 py-3 text-left text-sm \$\{activeFolder === folder \? "bg-zinc-800" : "text-zinc-400 hover:bg-zinc-800\/60"\}`\}>\r?\n                  <FolderOpen className="mr-2 inline size-4" \/>\{folder\}\r?\n                <\/button>\r?\n              \)\)\}\r?\n            <\/CardContent>\r?\n          <\/Card>/;

const replacement = '          <ManifestFolderPanel api={api} busy={busy} enabled={view === "personal"} onRefresh={refresh} onSelectFolder={(folder) => setActiveFolder(folder?.name || ALL_FILES)} />';

if (!src.includes('<ManifestFolderPanel api={api}')) {
  const next = src.replace(oldFoldersCard, replacement);
  if (next === src) {
    console.warn('[folder-panel-shell] Folders card marker not found; shell not mounted');
  } else {
    src = next;
  }
}

if (src !== before) {
  fs.writeFileSync(livePath, src, 'utf8');
  console.log('[folder-panel-shell] mounted isolated ManifestFolderPanel');
} else {
  console.log('[folder-panel-shell] already mounted or no complete UI to patch');
}
