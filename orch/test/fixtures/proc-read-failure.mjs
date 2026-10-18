import fs from 'node:fs';
const read=fs.readFileSync.bind(fs);
fs.readFileSync=function(file,...args){
  if(String(file)===`/proc/${process.env.ORCH_TEST_KEEPER_PID}/stat`&&fs.existsSync(process.env.ORCH_TEST_PROC_FAILURE)){
    fs.writeFileSync(process.env.ORCH_TEST_PROC_FAILURE+'.observed','read refused');
    throw Object.assign(Error('fixture procfs read refused'),{code:'EACCES'});
  }
  return read(file,...args);
};
