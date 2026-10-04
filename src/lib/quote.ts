import Decimal from 'decimal.js';
import type { Field, QuoteInput, QuoteTotals } from './contracts';
import { fieldValue } from './contracts';
import { AppError, assert } from './errors';
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export function decimalInput(value:unknown,label:string,positive=false,maxDecimals=8):Decimal {
 assert(typeof value==='string' && /^(?:0|[1-9]\d{0,12})(?:\.\d+)?$/.test(value),422,'INVALID_NUMBER',`${label}必须是明确填写的非负十进制数，不能留空或使用科学计数法`);
 assert((value.split('.')[1]?.length||0)<=maxDecimals,422,'NUMBER_PRECISION',`${label}最多支持 ${maxDecimals} 位小数`);
 const result=new Decimal(value);
 assert(result.isFinite() && (positive?result.gt(0):result.gte(0)),422,'INVALID_NUMBER',`${label}${positive?'必须大于零':'不能为负数'}`);
 return result;
}
export function calculateQuote(items:{id:string;fields:Field[]}[],input:QuoteInput):QuoteTotals {
 assert(items.length>0,422,'NO_ITEMS','至少需要一条产品明细');
 assert(input && typeof input==='object',422,'INVALID_QUOTE','请填写报价成本与规则');
 for(const [key,label] of [['costCurrency','成本币种'],['quoteCurrency','报价币种']] as const) assert(typeof input[key]==='string' && /^[A-Z]{3}$/.test(input[key]),422,'INVALID_CURRENCY',`${label}应为三个大写字母，例如 CNY / USD`);
 const markup=decimalInput(input.markupPercent,'加价率').div(100);
 const fx=decimalInput(input.exchangeRate,'汇率',true);
 assert(markup.lte(100),422,'INVALID_MARKUP','加价率超过允许范围 10000%');
 assert(input.costCurrency!==input.quoteCurrency || fx.eq(1),422,'SAME_CURRENCY_FX','相同币种的汇率必须为 1');
 const freight=decimalInput(input.freight,'运费',false,6), other=decimalInput(input.otherCosts,'其他费用',false,6);
 const multiplier=markup.plus(1);
 const lines=items.map(item=>{
   const get=(k:string)=>fieldValue(item.fields.find(f=>f.key===k));
   const quantity=decimalInput(get('quantity'),'数量',true,6);
   assert(get('unit').trim(),422,'MISSING_UNIT','数量单位未填写');
   const unitCost=decimalInput(input.unitCosts?.[item.id],'单位成本',false,6);
   const cost=quantity.mul(unitCost);
   return {itemId:item.id,name:get('productName'),model:get('model'),quantity:quantity.toFixed(),unit:get('unit'),unitCost:unitCost.toFixed(),costTotal:cost.toFixed(2),saleTotal:cost.mul(multiplier).div(fx).toFixed(2),specifications:['material','dimensions','technicalParameters'].map(k=>get(k)).filter(Boolean).join(' / '),_exactCost:cost};
 });
 const costTotal=lines.reduce((v,l)=>v.add(l._exactCost),new Decimal(0)).add(freight).add(other);
 assert(costTotal.lte('1000000000000'),422,'TOTAL_LIMIT','成本总计超过本演示系统允许范围');
 const saleCost=costTotal.mul(multiplier), total=saleCost.div(fx).toDecimalPlaces(2);
 const freightSale=freight.mul(multiplier).div(fx).toFixed(2), otherSale=other.mul(multiplier).div(fx).toFixed(2);
 const displayed=lines.reduce((v,l)=>v.add(l.saleTotal),new Decimal(0)).add(freightSale).add(otherSale);
 return {lines:lines.map(({_exactCost,...line})=>line),freightCost:freight.toFixed(2),otherCost:other.toFixed(2),freightSale,otherSale,costTotal:costTotal.toFixed(2),saleCostCurrency:saleCost.toFixed(2),total:total.toFixed(2),grossMarginPercent:costTotal.isZero()?'不适用':markup.div(multiplier).mul(100).toFixed(2),roundingAdjustment:total.minus(displayed).toFixed(2)};
}
export function businessDate(date=new Date()) {return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);}
export function validateQuoteTerms(input:QuoteInput) {
 assert(/^\d{4}-\d{2}-\d{2}$/.test(input.validUntil||'') && Number.isFinite(Date.parse(input.validUntil)) && new Date(input.validUntil).toISOString().slice(0,10)===input.validUntil,422,'INVALID_VALIDITY','审批前请填写有效的报价截止日期');
 assert(input.validUntil>=businessDate(),422,'EXPIRED_QUOTE','报价有效期已过，不能审批或正式导出');
 assert(!/\b(?:next (?:week|month)|this week|asap|soon|tomorrow)\b|下周|明天|尽快/i.test(input.deliveryTerms||''),422,'AMBIGUOUS_DELIVERY','报价交期不能只写下周或尽快，请填写绝对日期或明确的起算条件');
 for(const [key,label] of [['deliveryTerms','交期'],['paymentTerms','付款条件'],['incoterms','Incoterms']] as const) assert(input[key]?.trim() && !/^(pending|tbc|tbd|待确认)$/i.test(input[key].trim()),422,'UNCONFIRMED_TERMS',`审批前请人工明确${label}`);
}
export function defaultEmail(customer:string,input:QuoteInput,total:string,version:number) {
 return {subject:`Quotation QV-${version} for your RFQ`,body:`Dear ${customer || 'Customer'},\n\nThank you for your inquiry. Please review our quotation for the listed items.\n\nTotal: ${input.quoteCurrency} ${total}\nIncoterms: ${input.incoterms || 'To be confirmed'}\nDelivery: ${input.deliveryTerms || 'To be confirmed'}\nPayment: ${input.paymentTerms || 'To be confirmed'}\nValid until: ${input.validUntil || 'To be confirmed'}\n\nPlease confirm the specifications and commercial terms before placing an order.\n\nBest regards,\nSales Team`};
}
