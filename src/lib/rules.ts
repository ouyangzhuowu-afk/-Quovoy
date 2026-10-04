import type { Field, Issue, RFQDetail } from './contracts';
import { FIELD_LABELS, fieldValue } from './contracts';
import Decimal from 'decimal.js';
import { CATEGORY, isUnclear } from './category';
function comparable(key:string,value:string):string {const v=value.trim().toLowerCase();if(key==='quantity'){try{return new Decimal(v).toString();}catch{return v;}}return v;}
export function inspectRFQ(fields:Field[],items:{id:string;fields:Field[]}[],documents:{status:string;filename:string;warnings:string[]}[]):Issue[] {
 const issues:Issue[]=[];
 const add=(id:string,severity:Issue['severity'],code:string,message:string,fs:Field[]=[])=>issues.push({id,severity,code,message,fieldIds:fs.map(f=>f.id),sourceLocations:fs.map(f=>f.sourceLocator || '人工输入 / 无定位')});
 const inspect=(fs:Field[],scope:string,required:string[])=>{
   for(const k of required) { const f=fs.find(f=>f.key===k),value=fieldValue(f);if(isUnclear(value))add(`${scope}-${k}-missing`,'blocker','MISSING_REQUIRED',`${scope}：缺少${FIELD_LABELS[k]||k}`,f?[f]:[]);if(/^不适用/.test(value) && (!CATEGORY.allowNotApplicable.includes(k) || !/^不适用[：:]\s*\S.+/.test(value)))add(`${scope}-${k}-na`,'blocker','INVALID_NOT_APPLICABLE',`${scope}：此字段不可直接跳过；允许不适用的尺寸字段须填写“不适用：原因”`,f?[f]:[]); }
   for(const k of new Set(fs.map(f=>f.key))) {
     const same=fs.filter(f=>f.key===k), nonempty=same.filter(f=>fieldValue(f).trim());
     if(new Set(nonempty.map(f=>comparable(k,fieldValue(f)))).size>1) add(`${scope}-${k}-conflict`,'blocker','CONFLICT',`${scope}：${FIELD_LABELS[k]||k}存在不同来源的冲突，请统一确认值`,same);
     for(const f of nonempty) {
       if(!f.confirmed) add(`${f.id}-unconfirmed`,'blocker','UNCONFIRMED',`${scope}：${FIELD_LABELS[k]||k}尚未人工确认`,[f]);
       if(f.verificationReason && !f.confirmed) add(`${f.id}-verify`,'warning','VERIFY_SOURCE',`${scope}：${f.verificationReason}`,[f]);
       if(k==='unit' && !CATEGORY.units.includes(fieldValue(f).toLowerCase())) add(`${f.id}-unit-ambiguous`,'blocker','AMBIGUOUS_UNIT','单位不明确或不属于已配置单位，请人工确认并统一单位',[f]);
       if(k==='quantity') {try{if(!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(fieldValue(f)) || !new Decimal(fieldValue(f)).gt(0))throw new Error();}catch{add(`${f.id}-invalid`,'blocker','INVALID_QUANTITY','数量必须为明确的正数（最多6位小数）',[f]);}}
       if(k==='targetDelivery' && /\b(next|this|asap|soon|within|tomorrow)\b|下周|尽快|明天/i.test(fieldValue(f))) add(`${f.id}-relative`,'warning','RELATIVE_DATE','目标交期是相对日期；请在报价商业条款中明确绝对日期或交期基准',[f]);
     }
   }
 };
 inspect(fields,'询价',['customer']);
 if(!items.length)add('no-items','blocker','NO_ITEMS','没有产品明细，请人工添加');
 const models=new Map<string,Field[]>();
 items.forEach((item,i)=>{inspect(item.fields,`产品 ${i+1}`,CATEGORY.required);const f=item.fields.find(f=>f.key==='model');const m=fieldValue(f).trim().toLowerCase();if(m)models.set(m,[...(models.get(m)||[]),...(f?[f]:[])]);});
 for(const [model,fs] of models)if(fs.length>1)add(`duplicate-${model}`,'warning','DUPLICATE_MODEL',`型号 ${model} 在多条产品行中重复，请核对是否为独立需求`,fs);
 for(const key of ['targetDelivery','destination','incoterms','paymentTerms','currency','validity'])if(!fieldValue(fields.find(f=>f.key===key)).trim())add(`missing-${key}`,'warning','MISSING_OPTIONAL',`客户未提供${FIELD_LABELS[key]}，可保留草稿`);
 for(const doc of documents)if(doc.status!=='parsed')add(`document-${doc.filename}`,'warning','UNPARSED_DOCUMENT',`${doc.filename}：未解析，需人工查看与补录；${doc.warnings.join('；')}`);
 return issues;
}
const EN:Record<string,string> = {customer:'customer name',productName:'product name',model:'model or part number',quantity:'quantity',unit:'unit',material:'material',dimensions:'dimensions',technicalParameters:'technical requirements',targetDelivery:'requested delivery date',destination:'destination',incoterms:'Incoterms',paymentTerms:'payment terms',currency:'currency',validity:'quote validity'};
export function clarificationDraft(fields:Field[],items:{fields:Field[]}[],issues:Issue[]) {
 const questions:string[]=[];
 const sets=[{name:'your inquiry',fields},...items.map((item,i)=>({name:`item ${i+1}`,fields:item.fields}))];
 for(const scope of sets)for(const key of new Set(scope.fields.map(f=>f.key))) { const fs=scope.fields.filter(f=>f.key===key);const vals=fs.map(fieldValue).filter(Boolean);if(!vals.length && key!=='technicalParameters' && key!=='contact')questions.push(`Please provide the ${EN[key]||key} for ${scope.name}.`);else if(new Set(vals.map(v=>comparable(key,v))).size>1)questions.push(`Please clarify the ${EN[key]||key} for ${scope.name}; the supplied documents state: ${[...new Set(vals)].join(' / ')}.`); }
 if(issues.some(i=>i.code==='UNPARSED_DOCUMENT'))questions.push('Please provide a readable text version of the attachments that could not be parsed. Dimensions, tolerances, manufacturing processes and manufacturability shown only in drawings require human engineering review.');
 return `Dear Customer,\n\nThank you for your inquiry.${questions.length?' To prepare an accurate quotation, please confirm the following:\n\n'+questions.map(q=>`- ${q}`).join('\n'):' We are reviewing the supplied specifications and will prepare a quotation after internal confirmation.'}\n\nBest regards,\nSales Team`;
}
export function supplierDraft(items:{fields:Field[]}[]) {return 'Dear Supplier,\n\nPlease provide your unit cost, lead time and quotation validity for the following requirements:\n\n'+items.map((item,i)=>`${i+1}. `+item.fields.filter(f=>fieldValue(f)).map(f=>`${EN[f.key]||f.key}: ${fieldValue(f)}`).join('; ')).join('\n')+'\n\nPlease flag any unclear specifications for confirmation. No purchase order or delivery commitment is implied.\n\nBest regards,\nPurchasing Team';}
