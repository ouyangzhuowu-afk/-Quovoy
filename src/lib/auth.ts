import { createHash, randomBytes } from 'node:crypto';
import { all, one, run, now, userFromRow, verifyPassword, audit, demoMode, type Row } from './db';
import { assert } from './errors';
import type { User } from './contracts';
export const SESSION_COOKIE = 'quovoy_session';
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
export function authenticate(token:string|undefined):User|null {
 if(!token || token.length>200) return null;
 const row=one('SELECT u.* FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?',digest(token),now());
 return row && (demoMode() || !['org-demo','org-isolation'].includes(row.organization_id))?userFromRow(row):null;
}
export function login(email:unknown,password:unknown):{user:User;token:string} {
 assert(typeof email==='string' && typeof password==='string' && email.length<=254 && password.length<=200,400,'INVALID_LOGIN','请输入有效的邮箱和密码');
 const normalized=email.trim().toLowerCase(), attemptKey=digest(normalized), cutoff=new Date(Date.now()-15*60*1000).toISOString();
 run('DELETE FROM login_attempts WHERE window_start<?',cutoff);
 const attempt=one('SELECT * FROM login_attempts WHERE address_hash=?',attemptKey);
 assert(!attempt || attempt.count<10,429,'LOGIN_RATE_LIMIT','登录尝试过多，请 15 分钟后重试');
 const row=one('SELECT * FROM users WHERE email=?',normalized);
 const valid=row?verifyPassword(password,row.password_hash):verifyPassword(password,'invalid:'+('0'.repeat(128)));
 if(!row || !valid || (!demoMode() && ['org-demo','org-isolation'].includes(row.organization_id))){run('INSERT INTO login_attempts(address_hash,count,window_start) VALUES(?,1,?) ON CONFLICT(address_hash) DO UPDATE SET count=count+1',attemptKey,now());assert(false,401,'INVALID_LOGIN','邮箱或密码不正确');}
 run('DELETE FROM login_attempts WHERE address_hash=?',attemptKey);
 run('DELETE FROM sessions WHERE expires_at<=?',now());
 const user=userFromRow(row),token=randomBytes(32).toString('base64url');
 run('INSERT INTO sessions VALUES(?,?,?)',digest(token),user.id,new Date(Date.now()+12*60*60*1000).toISOString());
 audit(user,null,'login',{});return {user,token};
}
export function logout(token:string|undefined) {if(token)run('DELETE FROM sessions WHERE token_hash=?',digest(token));}
export function requireRole(user:User,...roles:User['role'][]) {assert(roles.includes(user.role),403,'FORBIDDEN','当前角色无权执行此操作');}
export function requireRFQ(user:User,rfqId:string):Row { assert(typeof rfqId==='string' && rfqId.length>0,422,'INVALID_RFQ','请选择有效的询价');const row=one('SELECT * FROM rfqs WHERE id=? AND organization_id=?',rfqId,user.organizationId);assert(row,404,'NOT_FOUND','询价不存在或无权访问');return row; }
export function organizationUsers(user:User) {return all('SELECT * FROM users WHERE organization_id=? ORDER BY name',user.organizationId).map(userFromRow);}
export function validateOwner(user:User,ownerId:string) {assert(typeof ownerId==='string',422,'INVALID_OWNER','请选择当前组织的负责人');assert(one('SELECT id FROM users WHERE id=? AND organization_id=?',ownerId,user.organizationId),422,'INVALID_OWNER','负责人必须属于当前组织');}
