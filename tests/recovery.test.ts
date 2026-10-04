import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {login} from '../src/lib/auth';
import {all,one,run,closeDb} from '../src/lib/db';
import {AppError} from '../src/lib/errors';
import * as service from '../src/lib/service';
import type {User,ExtractionDocument} from '../src/lib/contracts';

// The Node test runner isolates this file in its own process; no development DB,
// real API credentials, network requests or unrelated test fixtures are used.
const tempDir=fs.mkdtempSync(path.join(os.tmpdir(),'quovoy-recovery-'));
const envKeys=['QUOVOY_DATA_DIR','DEMO_MODE','QUOVOY_PUBLIC_DEPLOYMENT','AI_PROVIDER','AI_API_KEY','AI_MODEL','AI_BASE_URL'] as const;
const originalEnv=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
const originalFetch=globalThis.fetch;
let sales:User;
before(()=>{
  process.env.QUOVOY_DATA_DIR=tempDir;process.env.DEMO_MODE='true';process.env.QUOVOY_PUBLIC_DEPLOYMENT='false';
  process.env.AI_PROVIDER='live';process.env.AI_API_KEY='test-recovery-placeholder';process.env.AI_MODEL='test-recovery-model';process.env.AI_BASE_URL='http://127.0.0.1:9/v1';
  sales=login('sales@quovoy.demo','DemoSales!2026').user;
});
afterEach(()=>{globalThis.fetch=originalFetch;process.env.AI_PROVIDER='live';});
after(()=>{
  globalThis.fetch=originalFetch;closeDb();fs.rmSync(tempDir,{recursive:true,force:true});
  for(const key of envKeys)if(originalEnv[key]===undefined)delete process.env[key];else process.env[key]=originalEnv[key];
});

const body=(name:string)=>`Customer: ${name}\nProduct: Recovery flange\nModel: RC-100\nQuantity: 100\nUnit: pcs\nMaterial: Stainless steel 304\nDimensions: 80 x 12 mm`;
const errorCode=(code:string)=>(error:unknown)=>error instanceof AppError && error.code===code;
const waitable=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};

function structuredReply(init?:RequestInit):Response {
  const request=JSON.parse(String(init?.body));
  assert.equal(request.model,'test-recovery-model');
  assert.equal(request.response_format.json_schema.strict,true);
  assert.equal(request.tools,undefined);
  const documents:ExtractionDocument[]=JSON.parse(request.messages[1].content).untrustedDocuments;
  const source=documents[0];
  const field=(key:string,label:string)=>{
    const segment=source.segments.find(s=>s.text.startsWith(`${label}:`))!;
    const rawValue=segment.text.slice(label.length+1).trim();
    return {key,rawValue,normalizedValue:rawValue,sourceDocumentId:source.id,sourceLocator:segment.locator,excerpt:segment.text};
  };
  const output={fields:[field('customer','Customer')],items:[{fields:[field('productName','Product'),field('model','Model'),field('quantity','Quantity'),field('unit','Unit'),field('material','Material'),field('dimensions','Dimensions')]}],warnings:[]};
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]}),{status:200});
}

async function failedFixture(name:string) {
  globalThis.fetch=(async()=>{throw new DOMException('Simulated provider timeout','TimeoutError');}) as typeof fetch;
  const imported=await service.importRFQ(sales,body(name),[]);
  const detail=service.getRFQ(sales,imported.rfqId);
  assert.equal(detail.jobs[0].status,'failed');assert.equal(detail.jobs[0].attempts,1);
  assert.equal(detail.items.length,0);assert.equal(detail.fields.length,8);
  assert.equal(service.downloadDocument(sales,detail.documents[0].id).bytes.toString(),body(name));
  return imported.rfqId;
}

function delayedProvider() {
  const entered=waitable<void>(),release=waitable<void>();
  let calls=0;
  globalThis.fetch=(async(_url,init)=>{
    calls++;assert.ok(init?.signal,'Real provider must carry its timeout signal');entered.resolve();
    await release.promise;return structuredReply(init);
  }) as typeof fetch;
  return {entered:entered.promise,release:()=>release.resolve(),get calls(){return calls;}};
}

test('manual empty item added while the real provider mock is pending survives its late response',async()=>{
  const rfqId=await failedFixture('During Parsing Add Item');
  const delayed=delayedProvider();const retry=service.processRFQ(sales,rfqId);
  await delayed.entered;
  const manual=service.addItem(sales,rfqId);
  const before=service.getRFQ(sales,rfqId);assert.equal(before.items.length,1);
  delayed.release();await retry;
  const after=service.getRFQ(sales,rfqId);
  assert.equal(after.items.length,1);assert.equal(after.items[0].id,manual.id);
  assert.deepEqual(after.items[0].fields.map(f=>f.id),before.items[0].fields.map(f=>f.id));
  assert.ok(after.items[0].fields.every(f=>f.method==='manual' && !f.normalizedValue));
  assert.equal(after.jobs[0].status,'failed');assert.match(after.jobs[0].error!,/人工/);
  assert.equal(after.revision,before.revision);
});

test('manual field update while the real provider mock is pending cannot be overwritten or reset',async()=>{
  const rfqId=await failedFixture('During Parsing Update Field');
  const customer=service.getRFQ(sales,rfqId).fields.find(f=>f.key==='customer')!;
  const delayed=delayedProvider();const retry=service.processRFQ(sales,rfqId);await delayed.entered;
  service.updateField(sales,rfqId,customer.id,'Sales verified customer',true);
  const revision=service.getRFQ(sales,rfqId).revision;
  delayed.release();await retry;
  const after=service.getRFQ(sales,rfqId),persisted=after.fields.find(f=>f.id===customer.id)!;
  assert.equal(after.customer,'Sales verified customer');assert.equal(persisted.confirmedValue,'Sales verified customer');assert.equal(persisted.confirmed,true);assert.equal(persisted.editedBy,sales.id);assert.ok(persisted.editedAt);
  assert.equal(after.revision,revision);assert.equal(after.jobs[0].status,'failed');assert.match(after.jobs[0].error!,/人工/);
  assert.equal(after.items.length,0,'Late model products must not replace the manually reviewed state');
  closeDb();assert.equal(service.getRFQ(sales,rfqId).fields.find(f=>f.id===customer.id)?.confirmedValue,'Sales verified customer');
});

test('a manual empty item added BEFORE retry also blocks destructive reprocessing',async()=>{
  const rfqId=await failedFixture('Before Retry Add Item');
  const manual=service.addItem(sales,rfqId);let modelCalls=0;
  globalThis.fetch=(async(_url,init)=>{modelCalls++;return structuredReply(init);}) as typeof fetch;
  await assert.rejects(service.processRFQ(sales,rfqId),errorCode('MANUAL_EDITS_PRESERVED'));
  const after=service.getRFQ(sales,rfqId);
  assert.equal(after.items[0].id,manual.id);assert.equal(after.items.length,1);
  assert.equal(modelCalls,0,'Do not spend a model request on a job that may not overwrite manual work');
});

test('concurrent retries acquire only one persisted job and never duplicate product or field rows',async()=>{
  const rfqId=await failedFixture('Concurrent Retry');
  const delayed=delayedProvider();const first=service.processRFQ(sales,rfqId);await delayed.entered;
  const contenders=await Promise.allSettled([service.processRFQ(sales,rfqId),service.processRFQ(sales,rfqId)]);
  assert.ok(contenders.every(result=>result.status==='rejected' && errorCode('JOB_RUNNING')(result.reason)));
  assert.equal(delayed.calls,1);assert.equal(service.getRFQ(sales,rfqId).jobs[0].attempts,2);
  delayed.release();await first;
  const after=service.getRFQ(sales,rfqId);
  assert.equal(after.items.length,1);assert.equal(after.fields.length,8);assert.equal(after.items[0].fields.length,7);assert.equal(after.jobs[0].status,'completed');
  const itemId=after.items[0].id,fieldIds=[...after.fields,...after.items[0].fields].map(f=>f.id);
  await Promise.all([service.processRFQ(sales,rfqId),service.processRFQ(sales,rfqId)]);
  const repeated=service.getRFQ(sales,rfqId);
  assert.equal(repeated.items[0].id,itemId);assert.deepEqual([...repeated.fields,...repeated.items[0].fields].map(f=>f.id),fieldIds);
  assert.equal(repeated.jobs[0].attempts,2);assert.equal(delayed.calls,1);
  assert.equal(one('SELECT COUNT(*) count FROM jobs WHERE rfq_id=?',rfqId)!.count,1);
});

test('provider timeout is persisted without leaking upstream detail, survives restart, then recovers once',async t=>{
  let timeoutMilliseconds=0,requests=0;
  t.mock.method(AbortSignal,'timeout',(milliseconds:number)=>{
    timeoutMilliseconds=milliseconds;
    const controller=new AbortController();
    setTimeout(()=>controller.abort(new DOMException('Synthetic private timeout detail','TimeoutError')),5);
    return controller.signal;
  });
  globalThis.fetch=(async(_url,init)=>{
    requests++;
    return new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(init.signal!.reason),{once:true}));
  }) as typeof fetch;
  const name='Timeout And Recovery';const {rfqId}=await service.importRFQ(sales,body(name),[]);
  assert.equal(timeoutMilliseconds,45000);assert.equal(requests,1);
  const failed=service.getRFQ(sales,rfqId);assert.equal(failed.jobs[0].status,'failed');assert.equal(failed.items.length,0);assert.ok(failed.jobs[0].error);assert.doesNotMatch(failed.jobs[0].error!,/Synthetic private/);
  assert.equal(one('SELECT lease_until FROM jobs WHERE rfq_id=?',rfqId)!.lease_until,null);
  closeDb();const restarted=service.getRFQ(sales,rfqId);assert.equal(restarted.jobs[0].status,'failed');assert.equal(restarted.documents[0].text,body(name));
  globalThis.fetch=(async(_url,init)=>{requests++;return structuredReply(init);}) as typeof fetch;
  await service.processRFQ(sales,rfqId);
  const recovered=service.getRFQ(sales,rfqId);assert.equal(recovered.jobs[0].status,'completed');assert.equal(recovered.jobs[0].error,null);assert.equal(recovered.jobs[0].attempts,2);assert.equal(recovered.items.length,1);
  assert.equal(recovered.items[0].fields.find(f=>f.key==='quantity')?.normalizedValue,'100');
  await service.processRFQ(sales,rfqId);assert.equal(requests,2);assert.equal(all('SELECT id FROM items WHERE rfq_id=?',rfqId).length,1);
  assert.ok(recovered.audit.some(a=>a.action==='rfq.processing_failed'));assert.ok(recovered.audit.some(a=>a.action==='rfq.processed'));
});

test('matching repeated evidence across PDF and XLSX stays two items without false conflicts',async()=>{
  process.env.AI_PROVIDER='demo';
  const {rfqId}=await service.importSample(sales,'02-multiple');
  const detail=service.getRFQ(sales,rfqId);
  assert.equal(detail.items.length,2);
  assert.ok(detail.items.every(item=>item.fields.filter(f=>f.key==='model').length===2));
  assert.deepEqual(detail.issuesList.filter(issue=>['CONFLICT','DUPLICATE_MODEL'].includes(issue.code)),[]);
});

test('late completion from an expired lease cannot overwrite a newer successful attempt or its job status',async()=>{
  const rfqId=await failedFixture('Expired Lease Fencing');
  const staleProvider=delayedProvider();const staleAttempt=service.processRFQ(sales,rfqId);
  await staleProvider.entered;
  assert.equal(service.getRFQ(sales,rfqId).jobs[0].attempts,2);
  // Simulate a worker stalled beyond its persisted lease; do not wait two minutes.
  run('UPDATE jobs SET lease_until=? WHERE rfq_id=?',new Date(Date.now()-1000).toISOString(),rfqId);
  const currentProvider=delayedProvider();const currentAttempt=service.processRFQ(sales,rfqId);
  await currentProvider.entered;
  assert.equal(service.getRFQ(sales,rfqId).jobs[0].attempts,3);
  // New attempt finishes first. The old worker then returns the same valid model
  // output, which would still destroy current field/item IDs without fencing.
  currentProvider.release();await currentAttempt;
  const current=service.getRFQ(sales,rfqId);
  assert.equal(current.jobs[0].status,'completed');assert.equal(current.items.length,1);
  const currentJob=one('SELECT * FROM jobs WHERE rfq_id=?',rfqId)!;
  staleProvider.release();const staleResult=await staleAttempt;
  assert.match(staleResult.message,/迟到结果|较新的解析/);
  const final=service.getRFQ(sales,rfqId);
  assert.deepEqual(final.fields,current.fields);assert.deepEqual(final.items,current.items);
  assert.deepEqual(one('SELECT * FROM jobs WHERE rfq_id=?',rfqId),currentJob);
  assert.equal(final.jobs[0].status,'completed');assert.equal(final.jobs[0].error,null);assert.equal(final.jobs[0].attempts,3);
  assert.equal(final.audit.filter(a=>a.action==='rfq.processed').length,1);
  assert.equal(final.audit.filter(a=>a.action==='rfq.processing_failed').length,1,'Stale catch must not mark the newer job failed or add another failure event');
});

test('equivalent quantity strings 100 and 100.0 retain evidence without false conflict or clarification',async()=>{
  process.env.AI_PROVIDER='demo';
  const attachment=Buffer.from('Model: RC-100\nQuantity: 100.0\nUnit: pcs');
  const {rfqId}=await service.importRFQ(sales,body('Decimal Quantity Equivalence'),[{filename:'quantity-confirmation.txt',bytes:attachment}]);
  const detail=service.getRFQ(sales,rfqId);
  assert.equal(detail.items.length,1);
  const quantities=detail.items[0].fields.filter(field=>field.key==='quantity');
  assert.deepEqual(quantities.map(field=>field.rawValue),['100','100.0']);
  assert.equal(new Set(quantities.map(field=>field.sourceDocumentId)).size,2,'Original independent evidence must be retained');
  assert.deepEqual(detail.issuesList.filter(issue=>issue.code==='CONFLICT'),[]);
  assert.doesNotMatch(detail.clarificationDraft,/Please clarify the quantity/);
  // Actual numerical disagreement must still block; canonical comparison must
  // not suppress conflicts merely because both observations parse as decimals.
  service.updateField(sales,rfqId,quantities[1].id,'100.5',true);
  const changed=service.getRFQ(sales,rfqId);
  assert.ok(changed.issuesList.some(issue=>issue.code==='CONFLICT' && issue.message.includes('数量')));
  assert.match(changed.clarificationDraft,/Please clarify the quantity/);
});
