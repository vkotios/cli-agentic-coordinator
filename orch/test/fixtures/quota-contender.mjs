import {withQuotaAdmission} from '../../src/quota.mjs';
import {loadConfig} from '../../src/config.mjs';
const [policyFile,stateRoot,id]=process.argv.slice(2);
try {
  await withQuotaAdmission({args:{'quota-policy':policyFile,capability:'coding',size:'S'},cfg:loadConfig(stateRoot),cli:'codex',model:'a-model',role:'implement',id},async()=>{});
  process.stdout.write('reserved');
} catch(e) {process.stdout.write(e.code);process.exitCode=e.code==='quota-deferred'?3:2;}
