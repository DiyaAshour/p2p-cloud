require('child_process').execFileSync(process.execPath, ['scripts/patch-drive-folder-sync-ipc.cjs'], { stdio: 'inherit' });
require('child_process').execFileSync(process.execPath, ['scripts/patch-ui-folder-scope.cjs'], { stdio: 'inherit' });
require('child_process').execFileSync(process.execPath, ['scripts/patch-live-folder-core-actions.cjs'], { stdio: 'inherit' });
require('child_process').execFileSync(process.execPath, ['scripts/patch-live-folder-action-functions.cjs'], { stdio: 'inherit' });
require('child_process').execFileSync(process.execPath, ['scripts/patch-live-folder-action-ui.cjs'], { stdio: 'inherit' });
require('child_process').execFileSync(process.execPath, ['scripts/patch-live-folder-sync-save.cjs'], { stdio: 'inherit' });
require('child_process').execFileSync(process.execPath, ['scripts/verify-runtime-safety.cjs'], { stdio: 'inherit' });
