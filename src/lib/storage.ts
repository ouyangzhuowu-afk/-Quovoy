import fs from 'node:fs';
import path from 'node:path';
import {dataDir} from './db';
import {assert} from './errors';
export interface FileStore {
 put(key:string,bytes:Buffer):void;
 get(key:string):Buffer;
 has(key:string):boolean;
 remove(key:string):void;
}
/** Controlled UUID keys only. Original filenames never become filesystem paths. */
export class LocalFileStore implements FileStore {
 private filename(key:string) {assert(/^[a-f0-9-]{36}$/.test(key),400,'STORAGE_KEY','文件引用无效');return path.join(dataDir(),'files',key);}
 put(key:string,bytes:Buffer){const filename=this.filename(key);fs.mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});fs.writeFileSync(filename,bytes,{mode:0o600,flag:'wx'});}
 get(key:string){return fs.readFileSync(this.filename(key));}
 has(key:string){return fs.existsSync(this.filename(key));}
 remove(key:string){fs.rmSync(this.filename(key),{force:true});}
}
export const fileStore:FileStore=new LocalFileStore();
