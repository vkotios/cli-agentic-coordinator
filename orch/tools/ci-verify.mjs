import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPlan } from './ci-plan.mjs';
import { executeGroups, saveResult } from './ci-run.mjs';
const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
async function main() {
    const args = process.argv.slice(2), value = k => { const i = args.indexOf(k); return i < 0 ? undefined : args[i + 1]; }, plan = await createPlan({ base: value('--base'), head: value('--head') ?? 'HEAD' });
    console.log('CI_PLAN ' + JSON.stringify(plan));
    if (args.includes('--list'))
        return;
    for (const entry of ['orch/node_modules/typescript/bin/tsc', 'orch/tools/release-scan.mjs'])
        execFileSync(process.execPath, [path.join(root, entry), ...(entry.endsWith('/tsc') ? ['-p', 'tsconfig.json'] : [root])], { cwd: path.join(root, 'orch'), windowsHide: true, stdio: 'inherit' });
    const selected = await executeGroups(root, { groups: plan.groups }, [...plan.commit, ...plan.integration], { label: 'affected' });
    saveResult(root, selected);
    if (selected.code !== 0) {
        process.exitCode = selected.code;
        return;
    }
    if (plan.stress) {
        const stress = await executeGroups(root, { groups: plan.groups }, Object.keys(plan.groups), { label: 'required-lifecycle-stress', stress: true });
        saveResult(root, stress);
        process.exitCode = stress.code;
    }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
