import {db,one,run,id,hashPassword,transaction,closeDb,demoMode} from '../src/lib/db';
import {assert} from '../src/lib/errors';
assert(!demoMode(),400,'DEMO_MODE','正式账号初始化请设置 DEMO_MODE=false');
const org=process.env.BOOTSTRAP_ORG_NAME,sales=process.env.BOOTSTRAP_SALES_EMAIL,manager=process.env.BOOTSTRAP_MANAGER_EMAIL,sp=process.env.BOOTSTRAP_SALES_PASSWORD,mp=process.env.BOOTSTRAP_MANAGER_PASSWORD;
assert(org && sales && manager && sp && mp,400,'CONFIG','请填写 BOOTSTRAP_* 环境变量');
assert(sales!==manager && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sales) && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(manager),400,'EMAIL','请提供不同的有效销售/主管邮箱');
assert(sp.length>=14 && mp.length>=14,400,'PASSWORD','初始密码至少14个字符');
transaction(()=>{assert(!one('SELECT id FROM users WHERE email IN (?,?)',sales!.toLowerCase(),manager!.toLowerCase()),409,'EXISTS','账号已存在，本命令不会覆盖密码');const orgId=id();run('INSERT INTO organizations VALUES(?,?)',orgId,org!);for(const [email,password,role,name] of [[sales,sp,'sales','销售'],[manager,mp,'manager','主管']])run('INSERT INTO users VALUES(?,?,?,?,?,?)',id(),orgId,name!,email!.toLowerCase(),hashPassword(password!),role!);});
console.log('组织及两个账号已创建。请从配置中移除一次性 BOOTSTRAP 密码。');closeDb();
