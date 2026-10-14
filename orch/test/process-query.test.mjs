import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readProcessTable,verifyIdentity} from '../src/procs.mjs';

test('unreadable process queries retain bounded failure reasons without inventing liveness',async()=>{
  for(const result of [{raw:null,failure:{reason:'query-timeout',code:null,signal:'SIGTERM'}},{raw:null,failure:{reason:'query-error',code:'ENOENT',signal:null}},{raw:'not json',failure:null}]){
    const failures=[];
    const table=await readProcessTable({attempts:1,onFailure:f=>failures.push(f)},{query:async()=>result});
    assert.equal(table,null);
    assert.equal(verifyIdentity(42,'ms:1',table).verdict,'unknown');
    assert.equal(failures.length,1);
    assert.equal(failures[0].reason,result.failure?.reason??'invalid-json');
    assert.equal('raw' in failures[0],false);
    assert.equal('stderr' in failures[0],false);
  }
});

test('a failed query can recover within its existing budget and diagnostics cannot break a read',async()=>{
  let calls=0;const failures=[];
  const table=await readProcessTable({onFailure:f=>failures.push(f)},{query:async()=>++calls===1?{raw:null,failure:{reason:'query-error',code:1,signal:null}}:{raw:'{"ProcessId":42,"ParentProcessId":1,"Name":"test","CreationDate":"ms:1"}',failure:null}});
  assert.equal(calls,2);assert.equal(failures.length,1);assert.equal(verifyIdentity(42,'ms:1',table).verdict,'match');
  assert.equal(await readProcessTable({attempts:1,onFailure:()=>{throw Error('diagnostics unavailable');}},{query:async()=>({raw:null,failure:{reason:'query-timeout'}})}),null);
});
