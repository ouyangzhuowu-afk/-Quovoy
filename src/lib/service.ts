import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import { all, one, run, id, now, transaction, dataDir, audit, demoMode } from './db';
import { assert, AppError } from './errors';
import { requireRFQ, requireRole, validateOwner } from './auth';
import { FIELD_LABELS, RFQ_FIELD_KEYS, ITEM_FIELD_KEYS, fieldValue } from './contracts';
import type { User, Field, FieldInput, RFQDetail, RFQSummary, Quote, QuoteInput, FollowUpTask, ExtractionResult, ParsedDocument, RFQStatus } from './contracts';
import { calculateQuote, defaultEmail, validateQuoteTerms } from './quote';
import { inspectRFQ, clarificationDraft, supplierDraft } from './rules';
import {parseDocument,parseText} from './parsing';
import {getAIProvider} from './ai-provider';
import {fileStore} from './storage';
const ALLOWED_STATUS = new Set(['new','waiting_customer','waiting_supplier','pending_approval','quoted','following_up','won','lost','paused']);
const bytesLimit=10*1024*1024;
export type Upload = {filename:string;bytes:Buffer;mimeType?:string};
const json=(v:string)=>JSON.parse(v);
export function fieldsFor(rfqId:string):Field[] { return all('SELECT * FROM fields WHERE rfq_id=? ORDER BY rowid',rfqId).map(r=>({id:r.id,itemId:r.item_id,key:r.field_key,rawValue:r.raw_value,normalizedValue:r.normalized_value,sourceDocumentId:r.source_document_id,sourceLocator:r.source_locator,excerpt:r.excerpt,method:r.method,verificationReason:r.verification_reason,confirmedValue:r.confirmed_value,confirmed:!!r.confirmed,editedBy:r.edited_by,editedAt:r.edited_at})); }
export function getQuote(user:User,quoteId:string):Quote {
 const q=one('SELECT * FROM quotes WHERE id=? AND organization_id=?',quoteId,user.organizationId);assert(q,404,'NOT_FOUND','报价不存在或无权访问');
 return {id:q.id,rfqId:q.rfq_id,version:q.version,rfqRevision:q.rfq_revision,status:q.status,input:json(q.input_json),totals:json(q.totals_json),emailSubject:q.email_subject,emailBody:q.email_body,createdAt:q.created_at,createdBy:q.created_by,approvedAt:q.approved_at,sentAt:q.sent_at,returnReason:q.return_reason};
}
export function listTasks(user:User):FollowUpTask[] {return all(`SELECT t.*,u.name owner_name,r.customer FROM tasks t JOIN users u ON u.id=t.owner_id JOIN rfqs r ON r.id=t.rfq_id WHERE t.organization_id=? ORDER BY t.status DESC,t.due_at`,user.organizationId).map(r=>({id:r.id,rfqId:r.rfq_id,quoteId:r.quote_id,title:r.title,ownerId:r.owner_id,ownerName:r.owner_name,dueAt:r.due_at,status:r.status,completedAt:r.completed_at,customer:r.customer}));}
function coreDetail(user:User,rfqId:string) {
 const row=requireRFQ(user,rfqId),fields=fieldsFor(rfqId);
 const items=all('SELECT * FROM items WHERE rfq_id=? ORDER BY position',rfqId).map(i=>({id:i.id,position:i.position,fields:fields.filter(f=>f.itemId===i.id)}));
 const documents=all('SELECT * FROM documents WHERE rfq_id=? AND organization_id=? ORDER BY rowid',rfqId,user.organizationId).map(d=>({id:d.id,filename:d.filename,kind:d.kind,status:d.status,text:d.text_content,segments:json(d.segments_json),warnings:json(d.warnings_json)}));
 const rfqFields=fields.filter(f=>!f.itemId),issuesList=inspectRFQ(rfqFields,items,documents);
 return {row,fields:rfqFields,items,documents,issuesList};
}
export function getRFQ(user:User,rfqId:string):RFQDetail {
 const c=coreDetail(user,rfqId),{row}=c;
 return {quoteDraft:json(one('SELECT input_json FROM quote_drafts WHERE rfq_id=?',rfqId)?.input_json||'null'),id:row.id,customer:row.customer,createdAt:row.created_at,status:row.status,ownerId:row.owner_id,ownerName:one('SELECT name FROM users WHERE id=?',row.owner_id)!.name,issues:c.issuesList.length,blockers:c.issuesList.filter(i=>i.severity==='blocker').length,itemCount:c.items.length,synthetic:!!row.synthetic,revision:row.revision,fields:c.fields,items:c.items,documents:c.documents,issuesList:c.issuesList,quotes:all('SELECT id FROM quotes WHERE rfq_id=? ORDER BY version DESC',rfqId).map(q=>getQuote(user,q.id)),tasks:listTasks(user).filter(t=>t.rfqId===rfqId),jobs:all('SELECT id,status,attempts,error FROM jobs WHERE rfq_id=?',rfqId) as RFQDetail['jobs'],clarificationDraft:clarificationDraft(c.fields,c.items,c.issuesList),supplierDraft:supplierDraft(c.items),reviewSeconds:row.review_seconds,audit:all('SELECT a.*,u.name actor_name FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id WHERE a.rfq_id=? AND a.organization_id=? ORDER BY a.created_at DESC LIMIT 100',rfqId,user.organizationId).map(a=>({id:a.id,action:a.action,actorName:a.actor_name||'系统',createdAt:a.created_at,detail:a.detail}))};
}
export function listRFQs(user:User) { const rfqs:RFQSummary[]=all('SELECT id FROM rfqs WHERE organization_id=? ORDER BY created_at DESC',user.organizationId).map(r=>{const d=getRFQ(user,r.id);return {id:d.id,customer:d.customer,createdAt:d.createdAt,status:d.status,ownerName:d.ownerName,ownerId:d.ownerId,issues:d.issues,blockers:d.blockers,itemCount:d.itemCount,synthetic:d.synthetic,revision:d.revision};});return {rfqs,stats:{total:rfqs.length,blockers:rfqs.filter(r=>r.blockers>0).length,pendingApproval:rfqs.filter(r=>r.status==='pending_approval').length,overdue:listTasks(user).filter(t=>t.status==='pending' && t.dueAt<now()).length}}; }
function addField(rfqId:string,itemId:string|null,f:FieldInput) { run('INSERT INTO fields(id,rfq_id,item_id,field_key,raw_value,normalized_value,source_document_id,source_locator,excerpt,method,verification_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?)',id(),rfqId,itemId,f.key,f.rawValue||'',f.normalizedValue||'',f.sourceDocumentId||null,f.sourceLocator||null,f.excerpt||null,f.method,f.verificationReason||null); }
function storeFields(rfqId:string,result:ExtractionResult) {
 const normalize=(fields:FieldInput[],keys:string[])=>[...fields.filter(f=>keys.includes(f.key)),...keys.filter(k=>!fields.some(f=>f.key===k)).map(key=>({key,rawValue:'',normalizedValue:'',sourceDocumentId:null,sourceLocator:null,excerpt:null,method:'manual' as const,verificationReason:'未提取，请人工补录'}))];
 normalize(result.fields,RFQ_FIELD_KEYS).forEach(f=>addField(rfqId,null,f));
 result.items.forEach((item,i)=>{const itemId=id();run('INSERT INTO items VALUES(?,?,?)',itemId,rfqId,i+1);normalize(item.fields,ITEM_FIELD_KEYS).forEach(f=>addField(rfqId,itemId,f));});
 const name=result.fields.find(f=>f.key==='customer')?.normalizedValue || '待确认客户';
 const row=one('SELECT organization_id FROM rfqs WHERE id=?',rfqId)!;const customerId=id();
 run('INSERT INTO customers VALUES(?,?,?)',customerId,row.organization_id,name);
 run('UPDATE rfqs SET customer=?,customer_id=? WHERE id=?',name,customerId,rfqId);
}
export async function importRFQ(user:User,text:string,uploads:Upload[],synthetic=false) {
 requireRole(user,'sales');assert(typeof text==='string' && text.length<=250000,413,'TEXT_LIMIT','邮件正文最多 250000 个字符');
 assert(text.trim() || uploads.length,422,'EMPTY_IMPORT','请粘贴邮件正文或选择文件');assert(uploads.length<=10,413,'FILE_COUNT','单次最多导入 10 个文件');
 for(const u of uploads)assert(u.bytes.length<=bytesLimit,413,'FILE_SIZE',`${u.filename} 超过 10 MB 限制`);
 assert(uploads.reduce((sum,u)=>sum+u.bytes.length,0)<=25*1024*1024,413,'TOTAL_SIZE','单次文件总大小不能超过 25 MB');
 const components=uploads.map(u=>({kind:path.extname(u.filename).toLowerCase(),sha256:createHash('sha256').update(u.bytes).digest('hex')})).sort((a,b)=>a.kind.localeCompare(b.kind)||a.sha256.localeCompare(b.sha256));
 const hash=createHash('sha256').update(JSON.stringify({text:text.trim(),files:components}));
 const contentHash=hash.digest('hex'),existing=one('SELECT id FROM rfqs WHERE organization_id=? AND content_hash=?',user.organizationId,contentHash);
 if(existing)return {rfqId:existing.id,duplicate:true,message:'已识别重复导入，已打开原询价'};
 const rfqId=id(),docs: {doc:ParsedDocument;bytes:Buffer}[]=[];
 if(text.trim())docs.push({doc:parseText(text.trim()),bytes:Buffer.from(text.trim())});
 for(const u of uploads) {
   try { const parsed=await parseDocument(u.bytes,u.filename,u.mimeType);for(let i=0;i<parsed.length;i++)docs.push({doc:parsed[i],bytes:parsed[i].bytes || (i===0?u.bytes:Buffer.from(parsed[i].text))}); }
   catch(e){docs.push({doc:{filename:path.basename(u.filename),kind:'unsupported',status:'failed',text:'',segments:[],warnings:['解析失败，请下载原件检查后重新导入或转人工补录。']},bytes:u.bytes});}
 }
 const written:string[]=[];
 try {transaction(()=>{
   run('INSERT INTO rfqs(id,organization_id,created_at,owner_id,content_hash,synthetic) VALUES(?,?,?,?,?,?)',rfqId,user.organizationId,now(),user.id,contentHash,synthetic?1:0);
   for(const {doc,bytes} of docs){const docId=id();fileStore.put(docId,bytes);written.push(docId);run('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,?,?)',docId,user.organizationId,rfqId,path.basename(doc.filename).slice(0,240),doc.kind,doc.status,doc.text,JSON.stringify(doc.segments),JSON.stringify(doc.warnings),docId,doc.mimeType||'application/octet-stream');}
   run('INSERT INTO jobs(id,organization_id,rfq_id,status,attempts,updated_at) VALUES(?,?,?,?,?,?)',id(),user.organizationId,rfqId,'pending',0,now());
   audit(user,rfqId,'rfq.imported',{synthetic,files:docs.length});
 });}catch(e){for(const key of written)fileStore.remove(key);const duplicate=one('SELECT id FROM rfqs WHERE organization_id=? AND content_hash=?',user.organizationId,contentHash);if(duplicate)return {rfqId:duplicate.id,duplicate:true};throw e;}
 await processRFQ(user,rfqId);
 return {rfqId,duplicate:false};
}
export async function processRFQ(user:User,rfqId:string) {
 requireRole(user,'sales');requireRFQ(user,rfqId);
 const acquired=transaction(()=>{const job=one('SELECT * FROM jobs WHERE rfq_id=?',rfqId);assert(job,404,'NOT_FOUND','解析任务不存在');if(job.status==='completed')return null;
 assert(job.status!=='running' || !job.lease_until || job.lease_until<now(),409,'JOB_RUNNING','解析正在执行，请稍后刷新');
 assert(!one('SELECT id FROM fields WHERE rfq_id=? AND edited_at IS NOT NULL LIMIT 1',rfqId),409,'MANUAL_EDITS_PRESERVED','已有人工修订，重试不会覆盖。请继续人工整理或以新文件导入');
 run('UPDATE jobs SET status=?,attempts=attempts+1,error=NULL,lease_until=?,updated_at=? WHERE rfq_id=?','running',new Date(Date.now()+120000).toISOString(),now(),rfqId);return {revision:requireRFQ(user,rfqId).revision as number,attempt:job.attempts+1};});
 if(acquired===null)return {message:'作业已完成；重复重试未改动数据'};
 try {
   const docs=all('SELECT * FROM documents WHERE rfq_id=?',rfqId);
   for(const d of docs.filter(d=>d.status==='failed')) {
     try{const parsed=await parseDocument(fileStore.get(d.storage_key),d.filename,d.mime_type);const p=parsed[0];if(p)run('UPDATE documents SET status=?,text_content=?,segments_json=?,warnings_json=? WHERE id=?',p.status,p.text,JSON.stringify(p.segments),JSON.stringify(p.warnings),d.id);}catch{/* Failed document remains visible for manual review. */}
   }
   const fresh=all('SELECT * FROM documents WHERE rfq_id=?',rfqId),usable=fresh.filter(d=>d.status==='parsed');
   const extraction=await getAIProvider().extract(usable.map(d=>({id:d.id,filename:d.filename,text:d.text_content,segments:json(d.segments_json)})));
   assert(extraction.items.length<=100,422,'ITEM_LIMIT','提取超过100条产品，请拆分询价或人工整理');
   transaction(()=>{
     assert(one('SELECT attempts FROM jobs WHERE rfq_id=?',rfqId)?.attempts===acquired.attempt,409,'STALE_JOB','较新的解析任务已接管，此次迟到结果未应用');
     assert(requireRFQ(user,rfqId).revision===acquired.revision && !one('SELECT id FROM fields WHERE rfq_id=? AND edited_at IS NOT NULL LIMIT 1',rfqId),409,'MANUAL_EDITS_PRESERVED','解析期间存在人工修订，已保留人工数据');
     run('DELETE FROM fields WHERE rfq_id=?',rfqId);run('DELETE FROM items WHERE rfq_id=?',rfqId);storeFields(rfqId,extraction);
     const failed=fresh.some(d=>d.status==='failed');run('UPDATE jobs SET status=?,error=?,lease_until=NULL,updated_at=? WHERE rfq_id=?',failed?'failed':'completed',failed?'部分文件解析失败；已保留可读原文和字段，可重试或人工补录':null,now(),rfqId);
     audit(user,rfqId,'rfq.processed',{provider:getAIProvider().name,documents:usable.length,warnings:extraction.warnings});
   });
   return {message:'解析结束；请查看来源并人工确认'};
 }catch(e) {
   // Provider failures are retained as jobs. Partial/unsupported input remains accessible for manual work.
   const reason=e instanceof AppError?e.message:'模型或文档提取失败，请检查配置后重试，或继续人工补录';
   transaction(()=>{if(one('SELECT attempts FROM jobs WHERE rfq_id=?',rfqId)?.attempts!==acquired.attempt)return;if(!one('SELECT id FROM fields WHERE rfq_id=? LIMIT 1',rfqId))storeFields(rfqId,{fields:[],items:[],warnings:[]});run('UPDATE jobs SET status=?,error=?,lease_until=NULL,updated_at=? WHERE rfq_id=?','failed',reason,now(),rfqId);audit(user,rfqId,'rfq.processing_failed',{message:reason});});
   return {message:reason};
 }
}
function invalidate(user:User,rfqId:string,reason:string) {run('UPDATE rfqs SET revision=revision+1,status=CASE WHEN status IN (\'pending_approval\',\'quoted\',\'following_up\') THEN \'new\' ELSE status END WHERE id=?',rfqId);run("UPDATE quotes SET status='superseded' WHERE rfq_id=? AND status!='superseded'",rfqId);audit(user,rfqId,'approval.invalidated',{reason});}
export function updateField(user:User,rfqId:string,fieldId:string,value:unknown,confirmed:unknown) {
 requireRole(user,'sales');requireRFQ(user,rfqId);assert(typeof value==='string' && value.length<=2000 && typeof confirmed==='boolean',422,'INVALID_FIELD','字段值最多 2000 字符，确认状态须明确');
 return transaction(()=>{const f=one('SELECT * FROM fields WHERE id=? AND rfq_id=?',fieldId,rfqId);assert(f,404,'NOT_FOUND','字段不存在');
 const val=value.trim();if(f.confirmed_value===val && !!f.confirmed===confirmed)return {ok:true};
 run('UPDATE fields SET confirmed_value=?,confirmed=?,edited_by=?,edited_at=? WHERE id=?',val,confirmed?1:0,user.id,now(),fieldId);
 if(f.field_key==='customer' && !f.item_id){run('UPDATE rfqs SET customer=? WHERE id=?',val||'待确认客户',rfqId);run('UPDATE customers SET name=? WHERE id=(SELECT customer_id FROM rfqs WHERE id=?)',val||'待确认客户',rfqId);}
 invalidate(user,rfqId,'字段或人工确认状态变更');audit(user,rfqId,'field.edited',{fieldId,key:f.field_key,before:f.confirmed_value??f.normalized_value,after:val,confirmed});return {ok:true};});
}
export function addItem(user:User,rfqId:string) {requireRole(user,'sales');requireRFQ(user,rfqId);return transaction(()=>{const itemId=id(),pos=one('SELECT COALESCE(MAX(position),0)+1 pos FROM items WHERE rfq_id=?',rfqId)!.pos;assert(pos<=100,422,'ITEM_LIMIT','每份询价最多 100 条产品');run('INSERT INTO items VALUES(?,?,?)',itemId,rfqId,pos);for(const key of ITEM_FIELD_KEYS)addField(rfqId,itemId,{key,rawValue:'',normalizedValue:'',sourceDocumentId:null,sourceLocator:null,excerpt:null,method:'manual',verificationReason:'人工新增产品'});run('UPDATE fields SET edited_by=?,edited_at=? WHERE item_id=?',user.id,now(),itemId);invalidate(user,rfqId,'人工新增产品');return {id:itemId};});}
export function updateRFQ(user:User,rfqId:string,payload:{status?:string;ownerId?:string}) { requireRole(user,'sales');requireRFQ(user,rfqId);return transaction(()=>{if(payload.status){assert(ALLOWED_STATUS.has(payload.status),422,'INVALID_STATUS','询价状态无效');if(['quoted','following_up'].includes(payload.status))assert(one("SELECT id FROM quotes WHERE rfq_id=? AND status='approved' AND sent_at IS NOT NULL",rfqId),422,'SEND_CONFIRMATION_REQUIRED','请先在已批准报价中人工确认已发送');if(payload.status==='pending_approval')assert(one("SELECT id FROM quotes WHERE rfq_id=? AND status='pending'",rfqId),422,'NO_PENDING_QUOTE','请先提交报价审批');run('UPDATE rfqs SET status=? WHERE id=?',payload.status,rfqId);}if(payload.ownerId){validateOwner(user,payload.ownerId);run('UPDATE rfqs SET owner_id=? WHERE id=?',payload.ownerId,rfqId);}audit(user,rfqId,'rfq.updated',payload);return {ok:true};}); }
export function recordReviewTime(user:User,rfqId:string,seconds:unknown) {requireRFQ(user,rfqId);assert(typeof seconds==='number' && Number.isInteger(seconds) && seconds>0 && seconds<=28800,422,'INVALID_TIME','审核时长应为 1–28800 秒的整数');run('UPDATE rfqs SET review_seconds=review_seconds+? WHERE id=?',seconds,rfqId);audit(user,rfqId,'review.time_recorded',{seconds,measurement:'user_recorded_active_time'});return {reviewSeconds:requireRFQ(user,rfqId).review_seconds};}
export function createQuote(user:User,rfqId:string,input:QuoteInput):Quote {
 requireRole(user,'sales');requireRFQ(user,rfqId);
 assert(input && typeof input==='object',422,'INVALID_QUOTE','请填写报价规则');
 for(const k of ['deliveryTerms','paymentTerms','incoterms','validUntil','emailSubject','emailBody'] as const)if(input[k]!==undefined)assert(typeof input[k]==='string' && input[k]!.length<=(k==='emailBody'?20000:2000),422,'INVALID_QUOTE',`${k} 内容无效或过长`);
 return transaction(()=>{
 const detail=coreDetail(user,rfqId);input={...input,customerName:detail.row.customer};
 const previous=one('SELECT id FROM quotes WHERE rfq_id=? ORDER BY version DESC LIMIT 1',rfqId);
 if(previous){const prior=getQuote(user,previous.id);if(!prior.input.emailBody && input.emailBody===prior.emailBody)input.emailBody=undefined;if(!prior.input.emailSubject && input.emailSubject===prior.emailSubject)input.emailSubject=undefined;}
 const totals=calculateQuote(detail.items,input),quoteId=id();
 const version=one('SELECT COALESCE(MAX(version),0)+1 version FROM quotes WHERE rfq_id=?',rfqId)!.version;
 const draft=defaultEmail(detail.row.customer,input,totals.total,version);
 const emailSubject=input.emailSubject ?? draft.subject,emailBody=input.emailBody ?? draft.body;
 assert(emailSubject.trim() && emailBody.trim(),422,'EMPTY_EMAIL','报价英文邮件标题和正文不能为空');
 run("UPDATE quotes SET status='superseded' WHERE rfq_id=? AND status!='superseded'",rfqId);
 run('INSERT INTO quotes(id,rfq_id,organization_id,version,rfq_revision,status,input_json,totals_json,email_subject,email_body,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',quoteId,rfqId,user.organizationId,version,detail.row.revision,'draft',JSON.stringify(input),JSON.stringify(totals),emailSubject,emailBody,now(),user.id);
 totals.lines.forEach((line,i)=>run('INSERT INTO quote_items VALUES(?,?,?,?)',id(),quoteId,i+1,JSON.stringify(line)));
 run('INSERT INTO draft_messages VALUES(?,?,?,?,?,?,?)',id(),rfqId,quoteId,'quote',emailSubject,emailBody,now());
 run("UPDATE rfqs SET status=CASE WHEN status IN ('pending_approval','quoted','following_up') THEN 'new' ELSE status END WHERE id=?",rfqId);
 run('DELETE FROM quote_drafts WHERE rfq_id=?',rfqId);
 audit(user,rfqId,'quote.created',{quoteId,version,total:totals.total,currency:input.quoteCurrency});return getQuote(user,quoteId);
 });
}
function assertCurrent(user:User,q:Quote) { const r=requireRFQ(user,q.rfqId);assert(q.status!=='superseded' && q.rfqRevision===r.revision,409,'STALE_VERSION','询价或报价已经修改，请生成新版本并重新审批');assert(one('SELECT MAX(version) v FROM quotes WHERE rfq_id=?',q.rfqId)!.v===q.version,409,'STALE_VERSION','请使用最新报价版本'); }
function assertApprovable(user:User,q:Quote) {assertCurrent(user,q);const d=coreDetail(user,q.rfqId);const blockers=d.issuesList.filter(i=>i.severity==='blocker');assert(!blockers.length,422,'APPROVAL_BLOCKED',`还有 ${blockers.length} 项阻止审批的问题：${blockers.slice(0,3).map(b=>b.message).join('；')}`);validateQuoteTerms(q.input);const recomputed=calculateQuote(d.items,q.input);assert(JSON.stringify(recomputed)===JSON.stringify(q.totals),409,'QUOTE_CHANGED','报价计算快照已变化，请重新生成');}
export function submitQuote(user:User,quoteId:string) {requireRole(user,'sales');return transaction(()=>{const q=getQuote(user,quoteId);assert(['draft','returned'].includes(q.status),409,'INVALID_STATE','只有草稿或退回状态可提交');assertApprovable(user,q);run("UPDATE quotes SET status='pending',return_reason=NULL WHERE id=?",quoteId);run("UPDATE rfqs SET status='pending_approval' WHERE id=?",q.rfqId);audit(user,q.rfqId,'quote.submitted',{quoteId,version:q.version});return getQuote(user,quoteId);});}
export function approveQuote(user:User,quoteId:string) {requireRole(user,'manager');return transaction(()=>{const q=getQuote(user,quoteId);assert(q.status==='pending',409,'INVALID_STATE','只有待审批版本可批准');assertApprovable(user,q);run("UPDATE quotes SET status='approved',approved_at=? WHERE id=?",now(),quoteId);run("UPDATE rfqs SET status='new' WHERE id=?",q.rfqId);run('INSERT INTO approvals VALUES(?,?,?,?,?,?)',id(),quoteId,user.id,'approved',null,now());audit(user,q.rfqId,'quote.approved',{quoteId,version:q.version});return getQuote(user,quoteId);});}
export function returnQuote(user:User,quoteId:string,reason:unknown) {requireRole(user,'manager');assert(typeof reason==='string' && reason.trim().length>0 && reason.length<=2000,422,'RETURN_REASON','请填写退回原因（最多2000字）');return transaction(()=>{const q=getQuote(user,quoteId);assertCurrent(user,q);assert(q.status==='pending',409,'INVALID_STATE','只能退回待审批版本');run("UPDATE quotes SET status='returned',return_reason=? WHERE id=?",reason.trim(),quoteId);run("UPDATE rfqs SET status='new' WHERE id=?",q.rfqId);run('INSERT INTO approvals VALUES(?,?,?,?,?,?)',id(),quoteId,user.id,'returned',reason.trim(),now());audit(user,q.rfqId,'quote.returned',{quoteId,reason});return getQuote(user,quoteId);});}
export function confirmSent(user:User,quoteId:string) {return transaction(()=>{const q=getQuote(user,quoteId);assert(q.status==='approved',422,'NOT_APPROVED','只有已批准的报价版本可以确认发送');assertApprovable(user,q);const existing=one('SELECT id FROM tasks WHERE quote_id=?',quoteId);if(q.sentAt && existing)return {taskId:existing.id,alreadySent:true};
 const r=requireRFQ(user,q.rfqId),taskId=existing?.id||id();run('UPDATE quotes SET sent_at=COALESCE(sent_at,?) WHERE id=?',now(),quoteId);run("UPDATE rfqs SET status='quoted' WHERE id=?",q.rfqId);
 if(!existing)run('INSERT INTO tasks(id,organization_id,rfq_id,quote_id,title,owner_id,due_at,created_at) VALUES(?,?,?,?,?,?,?,?)',taskId,user.organizationId,q.rfqId,quoteId,`跟进已发送报价 V${q.version}`,r.owner_id,new Date(Date.now()+3*86400000).toISOString(),now());
 audit(user,q.rfqId,'quote.sent_confirmed',{quoteId,taskId,manualConfirmation:true});return {taskId,alreadySent:!!q.sentAt};});}
export function createTask(user:User,p:{rfqId:string;title:string;ownerId:string;dueAt:string}) {requireRFQ(user,p.rfqId);validateOwner(user,p.ownerId);assert(typeof p.title==='string' && p.title.trim() && p.title.length<=300,422,'TASK_TITLE','请输入跟进任务标题（最多300字）');assert(typeof p.dueAt==='string' && Number.isFinite(Date.parse(p.dueAt)),422,'TASK_DATE','请输入有效的到期时间');const taskId=id();run('INSERT INTO tasks(id,organization_id,rfq_id,title,owner_id,due_at,created_at) VALUES(?,?,?,?,?,?,?)',taskId,user.organizationId,p.rfqId,p.title.trim(),p.ownerId,new Date(p.dueAt).toISOString(),now());audit(user,p.rfqId,'task.created',{taskId});return {id:taskId};}
export function updateTask(user:User,taskId:string,p:{status?:string;dueAt?:string;ownerId?:string}) {return transaction(()=>{const task=one('SELECT * FROM tasks WHERE id=? AND organization_id=?',taskId,user.organizationId);assert(task,404,'NOT_FOUND','跟进任务不存在或无权访问');if(p.status){assert(['pending','completed'].includes(p.status),422,'TASK_STATUS','任务状态无效');run('UPDATE tasks SET status=?,completed_at=CASE WHEN ?=\'completed\' THEN COALESCE(completed_at,?) ELSE NULL END WHERE id=?',p.status,p.status,now(),taskId);}if(p.dueAt){assert(Number.isFinite(Date.parse(p.dueAt)),422,'TASK_DATE','到期时间无效');run('UPDATE tasks SET due_at=? WHERE id=?',new Date(p.dueAt).toISOString(),taskId);}if(p.ownerId){validateOwner(user,p.ownerId);run('UPDATE tasks SET owner_id=? WHERE id=?',p.ownerId,taskId);}audit(user,task.rfq_id,'task.updated',{taskId,...p});return {ok:true};});}
export function downloadDocument(user:User,docId:string) {const doc=one('SELECT * FROM documents WHERE id=? AND organization_id=?',docId,user.organizationId);assert(doc,404,'NOT_FOUND','附件不存在或无权访问');assert(fileStore.has(doc.storage_key),404,'FILE_MISSING','原始文件缺失，请从备份恢复或重新导入');audit(user,doc.rfq_id,'document.downloaded',{docId});return {bytes:fileStore.get(doc.storage_key),filename:doc.filename};}
export function listSamples() {if(!demoMode())return {samples:[]};const filename=path.resolve('samples/manifest.json');if(!fs.existsSync(filename))return {samples:[]};const content=json(fs.readFileSync(filename,'utf8'));return {samples:Array.isArray(content)?content:(content.samples||[])};}
export async function importSample(user:User,sampleId:string) {assert(demoMode(),404,'NOT_FOUND','合成样本仅在演示模式提供');const sample=listSamples().samples.find((s:any)=>s.id===sampleId);assert(sample,404,'NOT_FOUND','样本不存在');const root=path.resolve('samples');const uploads=sample.files.map((file:string)=>{const location=path.resolve(root,file);assert(location.startsWith(root+path.sep),422,'INVALID_SAMPLE','样本路径无效');return {filename:path.basename(file),bytes:fs.readFileSync(location)};});return importRFQ(user,'',uploads,true);}

export function saveQuoteDraft(user:User,rfqId:string,input:QuoteInput) {
 requireRole(user,'sales');requireRFQ(user,rfqId);
 assert(input && typeof input==='object' && !Array.isArray(input),422,'INVALID_DRAFT','请填写报价草稿');
 const draft:Record<string,unknown>={unitCosts:{}};
 for(const key of ['freight','otherCosts','markupPercent','exchangeRate','costCurrency','quoteCurrency','validUntil','deliveryTerms','paymentTerms','incoterms','emailSubject','emailBody']) {const value=(input as any)[key];assert(value===undefined || (typeof value==='string' && value.length<=(key==='emailBody'?20000:2000)),422,'INVALID_DRAFT','报价草稿字段无效或过长');if(value!==undefined)draft[key]=value;}
 assert(input.unitCosts && typeof input.unitCosts==='object' && !Array.isArray(input.unitCosts) && Object.keys(input.unitCosts).length<=100,422,'INVALID_DRAFT','产品成本草稿无效');
 for(const [key,value] of Object.entries(input.unitCosts)){assert(typeof value==='string' && value.length<=100 && one('SELECT id FROM items WHERE id=? AND rfq_id=?',key,rfqId),422,'INVALID_DRAFT','产品成本不属于当前询价或格式无效');(draft.unitCosts as Record<string,string>)[key]=value;}
 return transaction(()=>{const serialized=JSON.stringify(draft);if(one('SELECT input_json FROM quote_drafts WHERE rfq_id=?',rfqId)?.input_json===serialized)return {ok:true};run('INSERT INTO quote_drafts VALUES(?,?,?,?) ON CONFLICT(rfq_id) DO UPDATE SET input_json=excluded.input_json,edited_by=excluded.edited_by,updated_at=excluded.updated_at',rfqId,serialized,user.id,now());invalidate(user,rfqId,'报价工作草稿已变更');audit(user,rfqId,'quote.draft_saved',{uncalculated:true});return {ok:true};});
}
