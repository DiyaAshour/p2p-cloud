require('child_process').execFileSync(process.execPath, ['scripts/patch-drive-folder-sync-ipc.cjs'], { stdio: 'inherit' });
require('child_process').execFileSync(process.execPath, ['scripts/patch-ui-folder-scope.cjs'], { stdio: 'inherit' });
require('child_process').execFileSync(process.execPath, ['scripts/patch-live-folder-actions.cjs'], { stdio: 'inherit' });
require('child_process').execFileSync(process.execPath, ['scripts/verify-runtime-safety.cjs'], { stdio: 'inherit' });
