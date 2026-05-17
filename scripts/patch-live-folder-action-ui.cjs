const fs = require('node:fs');
const p = 'client/src/NativeP2PAppLive.tsx';
let s = fs.readFileSync(p, 'utf8');
let changed = false;
function r(a,b){ if(s.includes(a)){ s=s.replace(a,b); changed=true; } }
const from = '            <Button onClick={createFolder} disabled={busy}>+</Button>\n          </div>';
const to = '            <Button onClick={createFolder} disabled={busy}>+</Button>\n          </div>\n          {activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED && (\n            <div className="mt-2 grid gap-2">\n              <Button variant="outline" size="sm" onClick={renameActiveFolder} disabled={busy}>Rename folder</Button>\n              <Button variant="outline" size="sm" onClick={() => moveActiveFolderToParent(UNCATEGORIZED)} disabled={busy}>Move folder files to Uncategorized</Button>\n              <Button variant="destructive" size="sm" onClick={deleteActiveFolder} disabled={busy}>Delete folder</Button>\n            </div>\n          )}';
r(from, to);
if(changed){ fs.writeFileSync(p,s,'utf8'); console.log('[patch-live-folder-action-ui] installed'); } else console.log('[patch-live-folder-action-ui] already applied');
