import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {parseDocument,parseText,MAX_FILE_BYTES} from '../src/lib/parsing';
import {DemoProvider,StructuredOutputProvider,getAIProvider} from '../src/lib/ai-provider';
import type {ExtractionDocument,FieldInput,ParsedDocument} from '../src/lib/contracts';

type ExpectedField={key:string;rawValue:string;filename:string;locator:string};
type Fixture={id:string;synthetic:boolean;files:string[];expected:{itemCount:number;fields:ExpectedField[];items:{model:string;fields:ExpectedField[]}[];documentStatuses?:Record<string,string>}};
const sampleRoot=path.resolve('samples');
const asInput=(docs:ParsedDocument[]):ExtractionDocument[]=>docs.map((doc,i)=>({id:`doc-${i}`,filename:doc.filename,text:doc.text,segments:doc.segments}));
async function fixture(id:string) {
  const manifest=JSON.parse(await readFile(path.join(sampleRoot,'manifest.json'),'utf8')) as Fixture[];
  const sample=manifest.find(s=>s.id===id)!;
  const docs=(await Promise.all(sample.files.map(async file=>parseDocument(await readFile(path.join(sampleRoot,file)),path.basename(file))))).flat();
  const input=asInput(docs);
  return {sample,docs,input,result:await new DemoProvider().extract(input)};
}
function verifySource(expected:ExpectedField,actual:FieldInput[],documents:ExtractionDocument[]) {
  const found=actual.find(field=>field.key===expected.key && field.rawValue===expected.rawValue && field.sourceLocator===expected.locator && documents.find(d=>d.id===field.sourceDocumentId)?.filename===expected.filename);
  assert.ok(found,`Expected ${expected.filename} ${expected.locator}: ${expected.key} = ${expected.rawValue}`);
  assert.equal(found.method,'rule');
  assert.ok(found.excerpt?.includes(expected.rawValue));
  const segment=documents.find(d=>d.id===found.sourceDocumentId)?.segments.find(s=>s.locator===found.sourceLocator);
  assert.ok(segment?.text.includes(found.excerpt!),'Source excerpt must exist verbatim in actual parsed content');
}

test('all 12 labeled synthetic scenarios match authored expected fields, separate rows and actual source locations',async t=>{
  const manifest=JSON.parse(await readFile(path.join(sampleRoot,'manifest.json'),'utf8')) as Fixture[];
  assert.ok(manifest.length>=10);
  for (const sample of manifest) await t.test(sample.id,async()=>{
    assert.equal(sample.synthetic,true);
    const {docs,input,result}=await fixture(sample.id);
    assert.equal(result.items.length,sample.expected.itemCount);
    sample.expected.fields.forEach(field=>verifySource(field,result.fields,input));
    sample.expected.items.forEach((item,index)=>item.fields.forEach(field=>verifySource(field,result.items[index].fields,input)));
    Object.entries(sample.expected.documentStatuses || {}).forEach(([filename,status])=>{
      const doc=docs.find(d=>d.filename===filename);
      assert.equal(doc?.status,status);assert.ok(doc?.warnings.length);assert.ok(doc?.bytes?.length);
    });
  });
});

test('email attachments are decoded byte-for-byte; disagreements remain on one item',async()=>{
  const {docs,result}=await fixture('04-conflict');
  assert.equal(docs.length,2);
  assert.deepEqual(docs[1].bytes,await readFile(path.join(sampleRoot,'04-conflict/quantity-conflict.xlsx')));
  assert.deepEqual(result.items[0].fields.filter(f=>f.key==='quantity').map(f=>f.rawValue),['100','120']);
  assert.equal(new Set(result.items[0].fields.filter(f=>f.key==='quantity').map(f=>f.sourceDocumentId)).size,2);
});

test('arbitrary uploads never receive preset demo customer or product facts',async()=>{
  const doc=parseText('This is an unrelated memo. We have not supplied quantities or specifications.');
  const result=await new DemoProvider().extract(asInput([doc]));
  assert.deepEqual(result.fields,[]);assert.deepEqual(result.items,[]);assert.ok(result.warnings.some(w=>w.includes('人工补录')));
  const explicit=await new DemoProvider().extract(asInput([parseText('Customer: Totally Different Workshop\nItem 1\nProduct: Custom shaft\nModel: ZX-77\nQuantity: 1,200 pcs\nTechnical parameters: Polished; do not infer tolerances')]));
  assert.equal(explicit.fields[0].rawValue,'Totally Different Workshop');
  assert.equal(explicit.items[0].fields.find(f=>f.key==='quantity')?.normalizedValue,'1200');
  assert.equal(explicit.items[0].fields.find(f=>f.key==='unit')?.normalizedValue,'pcs');
  assert.equal(explicit.items[0].fields.find(f=>f.key==='technicalParameters')?.rawValue,'Polished; do not infer tolerances');
  assert.equal(explicit.fields.some(f=>f.key==='currency'),false);
});

test('corrupt, unsupported and over-limit input retains originals with explicit fallback',async()=>{
  const unsupported=await parseDocument(Buffer.from('untrusted source'),'../../drawing.step');
  assert.equal(unsupported[0].filename,'drawing.step');assert.equal(unsupported[0].status,'manual');assert.equal(unsupported[0].bytes?.toString(),'untrusted source');
  const corrupt=await parseDocument(Buffer.from('%PDF-1.7 damaged body'),'broken.pdf');
  assert.equal(corrupt[0].status,'failed');assert.ok(corrupt[0].warnings[0].includes('重试'));
  const huge=await parseDocument(Buffer.alloc(MAX_FILE_BYTES+1),'huge.pdf');
  assert.equal(huge[0].status,'failed');assert.match(huge[0].warnings[0],/10 MB/);
  const largeText=parseText('x'.repeat(250001));assert.equal(largeText.status,'manual');assert.equal(largeText.text.length,250000);assert.equal(largeText.bytes?.length,250001);assert.equal(largeText.segments[0].text.length,250000);
});

test('ZIP preflight rejects oversized expanded workbooks without inflating them',async()=>{
  const central=Buffer.alloc(46),end=Buffer.alloc(22);
  central.writeUInt32LE(0x02014b50,0);central.writeUInt32LE(50*1024*1024,24);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(1,10);end.writeUInt32LE(0,16);
  const [doc]=await parseDocument(Buffer.concat([central,end]),'bomb.xlsx');
  assert.equal(doc.status,'failed');assert.match(doc.warnings[0],/40 MB/);
});

test('Excel formula cached values are not trusted or evaluated',async()=>{
  const workbook=new ExcelJS.Workbook();const sheet=workbook.addWorksheet('Items');
  sheet.addRow(['Model','Quantity','Unit']);sheet.addRow(['F-9',{formula:'WEBSERVICE("https://example.test")',result:100},'pcs']);
  const docs=await parseDocument(Buffer.from(await workbook.xlsx.writeBuffer()),'formula.xlsx');
  assert.ok(docs[0].warnings.some(w=>w.includes('公式')));
  const result=await new DemoProvider().extract(asInput(docs));
  const quantity=result.items[0].fields.find(f=>f.key==='quantity');
  assert.notEqual(quantity?.rawValue,'100');assert.ok(quantity?.verificationReason?.includes('公式'));
});

test('untrusted body instructions remain source text and cannot create executable actions',async()=>{
  const {docs,result}=await fixture('10-injection');
  assert.ok(docs[0].text.includes('<script>'));
  assert.ok(result.warnings.some(w=>w.includes('不可信')));
  assert.equal(result.items.length,1);
  assert.deepEqual(Object.keys(result).sort(),['fields','items','warnings']);
  assert.ok([...result.fields,...result.items[0].fields].every(f=>!['role','approval','recipient'].includes(f.key)));
});

function modelResponse(data:unknown,finish_reason='stop') {return new Response(JSON.stringify({choices:[{finish_reason,message:{content:JSON.stringify(data)}}]}),{status:200});}
const sourceDocs:ExtractionDocument[]=[{id:'source-1',filename:'body.txt',text:'Quantity: 100',segments:[{locator:'text:line:1',text:'Quantity: 100'}]}];
const validModelField={key:'quantity',rawValue:'100',normalizedValue:'9999',sourceDocumentId:'source-1',sourceLocator:'text:line:1',excerpt:'Quantity: 100'};

test('structured provider sends strict schema without tools and independently verifies raw evidence',async()=>{
  let requestBody:Record<string,unknown>={};
  const provider=new StructuredOutputProvider({apiKey:'test-only',model:'test-model',fetchImpl:(async(_url,init)=>{
    requestBody=JSON.parse(String(init?.body));
    return modelResponse({fields:[],items:[{fields:[validModelField,{...validModelField,key:'material',rawValue:'Invented grade',sourceLocator:'fake:page:99'}]}],warnings:[]});
  }) as typeof fetch});
  const result=await provider.extract(sourceDocs);
  assert.equal(requestBody.tools,undefined);assert.equal(requestBody.store,false);
  assert.equal((requestBody.response_format as {json_schema:{strict:boolean}}).json_schema.strict,true);
  const [valid,fake]=result.items[0].fields;
  assert.equal(valid.normalizedValue,'100','model normalization cannot silently change original quantity');
  assert.equal(valid.sourceLocator,'text:line:1');assert.equal(valid.method,'model');
  assert.equal(fake.sourceDocumentId,null);assert.equal(fake.sourceLocator,null);assert.equal(fake.excerpt,null);assert.match(fake.verificationReason!,/人工核实/);
});

test('model refusals, invalid schemas, service failures and absent credentials fail explicitly for retry/manual recovery',async()=>{
  await assert.rejects(new StructuredOutputProvider({apiKey:'',model:''}).extract(sourceDocs),/未配置/);
  const provider=(fetchImpl:typeof fetch)=>new StructuredOutputProvider({apiKey:'test-only',model:'test-model',fetchImpl});
  await assert.rejects(provider((async()=>new Response('secret upstream detail',{status:503})) as typeof fetch).extract(sourceDocs),/HTTP 503/);
  await assert.rejects(provider((async()=>modelResponse({fields:[],items:[],warnings:[],role:'manager'})) as typeof fetch).extract(sourceDocs),/结构/);
  await assert.rejects(provider((async()=>modelResponse({fields:[],items:[],warnings:[]},'length')) as typeof fetch).extract(sourceDocs),/完整/);
  await assert.rejects(provider((async()=>{throw new Error('network error with sensitive content');}) as typeof fetch).extract(sourceDocs),/模型连接失败/);
});

test('provider selection requires an explicit real mode and does not silently downgrade bad configuration',()=>{
  const previousProvider=process.env.AI_PROVIDER,previousKey=process.env.AI_API_KEY;
  try {
    delete process.env.AI_PROVIDER;delete process.env.AI_API_KEY;assert.ok(getAIProvider() instanceof DemoProvider);
    process.env.AI_PROVIDER='live';assert.ok(getAIProvider() instanceof StructuredOutputProvider);
    process.env.AI_PROVIDER='typo';assert.throws(getAIProvider,/配置无效/);
    delete process.env.AI_PROVIDER;process.env.AI_API_KEY='test-only';assert.throws(getAIProvider,/明确选择/);
  } finally {
    if(previousProvider===undefined)delete process.env.AI_PROVIDER;else process.env.AI_PROVIDER=previousProvider;
    if(previousKey===undefined)delete process.env.AI_API_KEY;else process.env.AI_API_KEY=previousKey;
  }
});
