import {demoMode,one,userFromRow,closeDb} from '../src/lib/db';
import {assert} from '../src/lib/errors';
import {listSamples,importSample} from '../src/lib/service';
async function main(){assert(demoMode(),400,'DEMO_DISABLED','仅显式 DEMO_MODE=true 且非公开部署时可加载合成样本');const user=userFromRow(one('SELECT * FROM users WHERE id=?','sales-demo')!);for(const sample of listSamples().samples){const result=await importSample(user,sample.id);console.log(`${sample.id}: ${result.duplicate?'已存在 / 重复样本':'已导入合成询价'}`);}closeDb();}
main().catch(()=>{console.error('合成样本初始化失败；请检查配置和 samples/manifest.json');process.exitCode=1;});
