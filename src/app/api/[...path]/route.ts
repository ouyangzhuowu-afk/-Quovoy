import {NextRequest,NextResponse} from 'next/server';
import {authenticate,login,logout,organizationUsers,SESSION_COOKIE} from '@/lib/auth';
import {demoMode} from '@/lib/db';
import {AppError,assert} from '@/lib/errors';
import * as service from '@/lib/service';
import {exportQuote} from '@/lib/export';
export const runtime='nodejs';
export const dynamic='force-dynamic';
async function limitedBody(req:Request,max:number) {const declared=Number(req.headers.get('content-length'));assert(!declared || declared<=max,413,'BODY_LIMIT','请求超过允许大小');const reader=req.body?.getReader();if(!reader)return new Uint8Array();let total=0;const parts:Uint8Array[]=[];try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>max){await reader.cancel();throw new AppError(413,'BODY_LIMIT','请求超过允许大小');}parts.push(value);}}finally{reader.releaseLock();}const out=new Uint8Array(total);let offset=0;for(const part of parts){out.set(part,offset);offset+=part.length;}return out;}
async function payload(req:Request) {if(!req.headers.get('content-type')?.includes('application/json'))return {};const bytes=await limitedBody(req,100000);try{const value=bytes.length?JSON.parse(new TextDecoder().decode(bytes)):{};if(!value || typeof value!=='object' || Array.isArray(value))throw new Error();return value;}catch{throw new AppError(400,'INVALID_JSON','请求 JSON 格式无效');}}
async function handle(req:NextRequest,context:{params:Promise<{path:string[]}>}) {
 try{
 const p=(await context.params).path||[],method=req.method,token=req.cookies.get(SESSION_COOKIE)?.value;
 if(method!=='GET') {const origin=req.headers.get('origin'),expected=process.env.APP_ORIGIN||`${new URL(req.url).protocol}//${req.headers.get('host')||new URL(req.url).host}`;assert(!origin || origin===expected,403,'ORIGIN_REJECTED','请求来源不匹配');assert(req.headers.get('sec-fetch-site')!=='cross-site',403,'ORIGIN_REJECTED','不接受跨站修改请求');}
 const user=authenticate(token);
 if(method==='GET' && p[0]==='session')return NextResponse.json({user,demoMode:demoMode()},{headers:{'Cache-Control':'no-store'}});
 if(method==='GET' && p[0]==='health')return NextResponse.json({ok:true});
 if(method==='POST' && p[0]==='login') {const b=await payload(req),result=login(b.email,b.password);const res=NextResponse.json({user:result.user});res.cookies.set(SESSION_COOKIE,result.token,{httpOnly:true,sameSite:'strict',secure:new URL(req.url).protocol==='https:' || process.env.SECURE_COOKIES==='true',maxAge:43200,path:'/'});return res;}
 if(method==='POST' && p[0]==='logout') {logout(token);const res=NextResponse.json({ok:true});res.cookies.set(SESSION_COOKIE,'',{httpOnly:true,sameSite:'strict',maxAge:0,path:'/'});return res;}
 assert(user,401,'LOGIN_REQUIRED','请先登录');
 let result:unknown;
 if(p[0]==='users' && method==='GET')result={users:organizationUsers(user)};
 else if(p[0]==='rfqs' && p.length===1 && method==='GET')result=service.listRFQs(user);
 else if(p[0]==='rfqs' && p.length===1 && method==='POST') {
   assert(req.headers.get('content-type')?.includes('multipart/form-data'),400,'INVALID_IMPORT','导入请求应为 multipart/form-data');
   const bytes=await limitedBody(req,27*1024*1024);const copy=new Request(req.url,{method:'POST',headers:{'Content-Type':req.headers.get('content-type')!},body:bytes});
   let form:FormData;try{form=await copy.formData();}catch{throw new AppError(400,'INVALID_IMPORT','上传文件格式不正确，请重新选择');}
   const files=form.getAll('files').filter((x):x is File=>typeof x!=='string');const uploads=await Promise.all(files.map(async f=>({filename:f.name,bytes:Buffer.from(await f.arrayBuffer()),mimeType:f.type})));
   result=await service.importRFQ(user,String(form.get('text')||''),uploads,demoMode() && form.get('synthetic')==='true');
 }
 else if(p[0]==='rfqs' && p.length===2 && method==='GET')result=service.getRFQ(user,p[1]);
 else if(p[0]==='rfqs' && p.length===2 && method==='PATCH')result=service.updateRFQ(user,p[1],await payload(req));
 else if(p[0]==='rfqs' && p[2]==='fields' && p.length===4 && method==='PATCH') {const b=await payload(req);result=service.updateField(user,p[1],p[3],b.value,b.confirmed);}
 else if(p[0]==='rfqs' && p[2]==='items' && p.length===3 && method==='POST')result=service.addItem(user,p[1]);
 else if(p[0]==='rfqs' && p[2]==='retry' && p.length===3 && method==='POST')result=await service.processRFQ(user,p[1]);
 else if(p[0]==='rfqs' && p[2]==='review-time' && p.length===3 && method==='POST')result=service.recordReviewTime(user,p[1],(await payload(req)).seconds);
 else if(p[0]==='rfqs' && p[2]==='quote-draft' && p.length===3 && method==='POST')result=service.saveQuoteDraft(user,p[1],await payload(req));
 else if(p[0]==='rfqs' && p[2]==='quotes' && p.length===3 && method==='POST')result=service.createQuote(user,p[1],await payload(req));
 else if(p[0]==='quotes' && p.length===3) {
   if(method==='POST' && p[2]==='submit')result=service.submitQuote(user,p[1]);
   else if(method==='POST' && p[2]==='approve')result=service.approveQuote(user,p[1]);
   else if(method==='POST' && p[2]==='return')result=service.returnQuote(user,p[1],(await payload(req)).reason);
   else if(method==='POST' && p[2]==='sent')result=service.confirmSent(user,p[1]);
   else if(method==='GET' && p[2]==='export') {const out=exportQuote(user,p[1],req.nextUrl.searchParams.get('kind')||'internal');return new NextResponse(out.html,{headers:{'Content-Type':'text/html; charset=utf-8','Content-Disposition':`attachment; filename="${out.filename}"`,'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; sandbox"}});}
   else throw new AppError(404,'NOT_FOUND','接口不存在');
 }
 else if(p[0]==='documents' && p.length===2 && method==='GET'){const doc=service.downloadDocument(user,p[1]);return new NextResponse(new Uint8Array(doc.bytes),{headers:{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"}});}
 else if(p[0]==='tasks' && p.length===1 && method==='GET')result={tasks:service.listTasks(user)};
 else if(p[0]==='tasks' && p.length===1 && method==='POST')result=service.createTask(user,await payload(req));
 else if(p[0]==='tasks' && p.length===2 && method==='PATCH')result=service.updateTask(user,p[1],await payload(req));
 else if(p[0]==='samples' && p.length===1 && method==='GET')result=service.listSamples();
 else if(p[0]==='samples' && p.length===3 && p[2]==='import' && method==='POST')result=await service.importSample(user,p[1]);
 else throw new AppError(404,'NOT_FOUND','接口不存在');
 return NextResponse.json(result,{headers:{'Cache-Control':'no-store'}});
 }catch(e){if(e instanceof AppError)return NextResponse.json({error:e.message,code:e.code},{status:e.status});console.error('Quovoy request failed:',e instanceof Error?e.name:'UnknownError');return NextResponse.json({error:'操作失败，请稍后重试；已保存的数据不会因刷新丢失',code:'INTERNAL_ERROR'},{status:500});}
}
export const GET=handle,POST=handle,PATCH=handle;
