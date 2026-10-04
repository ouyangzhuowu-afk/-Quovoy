import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { User } from './contracts';

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const dataDir = () => path.resolve(/*turbopackIgnore: true*/ process.env.QUOVOY_DATA_DIR || './data');
export const demoMode = () => process.env.DEMO_MODE === 'true' && process.env.QUOVOY_PUBLIC_DEPLOYMENT !== 'true';
let instance: DatabaseSync | undefined;
export function db(): DatabaseSync {
 if(instance) return instance;
 fs.mkdirSync(dataDir(),{recursive:true,mode:0o700});
 instance=new DatabaseSync(path.join(dataDir(),'quovoy.sqlite'));
 instance.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id),name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('sales','manager')));
 CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS login_attempts(address_hash TEXT PRIMARY KEY,count INTEGER NOT NULL,window_start TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS customers(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id),name TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS rfqs(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id),customer_id TEXT REFERENCES customers(id),customer TEXT NOT NULL DEFAULT '待确认客户',created_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'new',owner_id TEXT NOT NULL REFERENCES users(id),content_hash TEXT NOT NULL,synthetic INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,review_seconds INTEGER NOT NULL DEFAULT 0,UNIQUE(organization_id,content_hash));
 CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id),rfq_id TEXT NOT NULL REFERENCES rfqs(id),filename TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,text_content TEXT NOT NULL DEFAULT '',segments_json TEXT NOT NULL DEFAULT '[]',warnings_json TEXT NOT NULL DEFAULT '[]',storage_key TEXT NOT NULL,mime_type TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,rfq_id TEXT NOT NULL REFERENCES rfqs(id),position INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS fields(id TEXT PRIMARY KEY,rfq_id TEXT NOT NULL REFERENCES rfqs(id),item_id TEXT REFERENCES items(id),field_key TEXT NOT NULL,raw_value TEXT NOT NULL DEFAULT '',normalized_value TEXT NOT NULL DEFAULT '',source_document_id TEXT REFERENCES documents(id),source_locator TEXT,excerpt TEXT,method TEXT NOT NULL,verification_reason TEXT,confirmed_value TEXT,confirmed INTEGER NOT NULL DEFAULT 0,edited_by TEXT REFERENCES users(id),edited_at TEXT);
 CREATE TABLE IF NOT EXISTS quotes(id TEXT PRIMARY KEY,rfq_id TEXT NOT NULL REFERENCES rfqs(id),organization_id TEXT NOT NULL REFERENCES organizations(id),version INTEGER NOT NULL,rfq_revision INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('draft','pending','returned','approved','superseded')),input_json TEXT NOT NULL,totals_json TEXT NOT NULL,email_subject TEXT NOT NULL,email_body TEXT NOT NULL,created_at TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),approved_at TEXT,sent_at TEXT,return_reason TEXT,UNIQUE(rfq_id,version));
 CREATE TABLE IF NOT EXISTS quote_drafts(rfq_id TEXT PRIMARY KEY REFERENCES rfqs(id),input_json TEXT NOT NULL,edited_by TEXT NOT NULL REFERENCES users(id),updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS quote_items(id TEXT PRIMARY KEY,quote_id TEXT NOT NULL REFERENCES quotes(id),position INTEGER NOT NULL,snapshot_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,quote_id TEXT NOT NULL REFERENCES quotes(id),actor_id TEXT NOT NULL REFERENCES users(id),action TEXT NOT NULL,reason TEXT,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS draft_messages(id TEXT PRIMARY KEY,rfq_id TEXT NOT NULL REFERENCES rfqs(id),quote_id TEXT REFERENCES quotes(id),kind TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id),rfq_id TEXT NOT NULL REFERENCES rfqs(id),quote_id TEXT UNIQUE REFERENCES quotes(id),title TEXT NOT NULL,owner_id TEXT NOT NULL REFERENCES users(id),due_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',completed_at TEXT,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id),rfq_id TEXT NOT NULL REFERENCES rfqs(id),status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,error TEXT,lease_until TEXT,updated_at TEXT NOT NULL,UNIQUE(rfq_id));
 CREATE TABLE IF NOT EXISTS audit_events(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id),rfq_id TEXT REFERENCES rfqs(id),actor_id TEXT REFERENCES users(id),action TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS rfq_org_idx ON rfqs(organization_id,created_at);
 CREATE INDEX IF NOT EXISTS field_rfq_idx ON fields(rfq_id);
 CREATE INDEX IF NOT EXISTS task_org_idx ON tasks(organization_id,status,due_at);
 `);
 if(demoMode()) seedDemo(instance);
 return instance;
}
export function closeDb() { instance?.close(); instance=undefined; }
export type Row = Record<string, any>;
export function one(sql:string,...params:any[]):Row|undefined { return db().prepare(sql).get(...params) as Row|undefined; }
export function all(sql:string,...params:any[]):Row[] { return db().prepare(sql).all(...params) as Row[]; }
export function run(sql:string,...params:any[]) { return db().prepare(sql).run(...params); }
export function transaction<T>(fn:()=>T):T { const conn=db(); conn.exec('BEGIN IMMEDIATE'); try { const out=fn(); conn.exec('COMMIT'); return out; } catch(e){conn.exec('ROLLBACK');throw e;} }
export function hashPassword(password:string) { const salt=randomBytes(16).toString('hex');return `${salt}:${scryptSync(password,salt,64).toString('hex')}`; }
export function verifyPassword(password:string,hash:string) { const [salt,hex]=hash.split(':'); const expected=Buffer.from(hex||'', 'hex'); const got=scryptSync(password,salt||'invalid',64);return expected.length===got.length && timingSafeEqual(got,expected); }
export function userFromRow(row:Row):User { return {id:row.id,organizationId:row.organization_id,name:row.name,email:row.email,role:row.role}; }
function seedDemo(conn:DatabaseSync) {
 const insertOrg=conn.prepare('INSERT OR IGNORE INTO organizations(id,name) VALUES(?,?)');
 insertOrg.run('org-demo','Quovoy 合成演示工厂'); insertOrg.run('org-isolation','隔离验证组织');
 const users=[['sales-demo','org-demo','林销售','sales@quovoy.demo','DemoSales!2026','sales'],['manager-demo','org-demo','周主管','manager@quovoy.demo','DemoManager!2026','manager'],['sales-isolation','org-isolation','隔离测试销售','isolation@quovoy.demo','DemoIsolation!2026','sales']];
 for(const u of users) if(!conn.prepare('SELECT id FROM users WHERE id=?').get(u[0])) conn.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(u[0],u[1],u[2],u[3],hashPassword(u[4]),u[5]);
}
export function audit(user:User, rfqId:string|null, action:string, detail:unknown) { run('INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)',id(),user.organizationId,rfqId,user.id,action,JSON.stringify(detail),now()); }
