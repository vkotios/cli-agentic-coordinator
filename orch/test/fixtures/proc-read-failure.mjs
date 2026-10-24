import fs from 'node:fs';
const read=fs.readFileSync.bind(fs);
fs.readFileSync=function(file,...args){
  if(String(file)===`/proc/${process.env.ORCH_TEST_KEEPER_PID}/stat`&&fs.existsSync(process.env.ORCH_TEST_PROC_FAILURE)){
    fs.writeFileSync(process.env.ORCH_TEST_PROC_FAILURE+'.observed','read refused');
    throw Object.assign(Error('fixture procfs read refused'),{code:'EACCES'});
  }
  return read(file,...args);
};

// Equivalent macOS denial at the bounded native-query boundary.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const exec = cp.execFile;
/** @type {any} */ (cp).execFile = function(file, args, options, callback) {
  if (String(file).endsWith('/darwin-processes') && args?.[0] === process.env.ORCH_TEST_KEEPER_PID && fs.existsSync(process.env.ORCH_TEST_PROC_FAILURE)) {
    fs.writeFileSync(process.env.ORCH_TEST_PROC_FAILURE + '.observed', 'read refused');
    queueMicrotask(() => callback(Object.assign(Error('fixture native read refused'), { code: 'EACCES' }), '', ''));
    return undefined;
  }
  return exec.call(this, file, args, options, callback);
};
syncBuiltinESMExports();
