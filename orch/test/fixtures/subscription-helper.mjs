// Fixture transport only. Production collectors never accept an endpoint override.
import {collectSubscription} from '../../src/subscription-collectors.mjs';
let text='';for await(const chunk of process.stdin)text+=chunk;
const req=JSON.parse(text),email='member@example.org';
const fixtures={cursor:[{email},{individualUsage:{plan:{used:12,limit:100}}}],copilot:[{id:123},{quota_snapshots:{premium_interactions:{remaining:12}}}],muse:[{user_email:email,is_subs_active:true}]};
const credentials={cursor:'WorkosCursorSessionToken=fixture-value',copilot:'gho_fixture-value',muse:'dca:fixture-value'};
const result=await collectSubscription(req,{version:1,provider:req.provider},credentials[req.provider],{now:Date.parse('2026-10-11T12:00:00Z'),fetchImpl:async()=>new Response(JSON.stringify(fixtures[req.provider].shift()))});
process.stdout.write(JSON.stringify(result));
