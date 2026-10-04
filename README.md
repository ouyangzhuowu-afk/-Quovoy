# Quovoy · AI 外贸运营员

面向机械零部件 / 金属加工件出口团队的技术 MVP：导入询价 → 查看来源并人工修正 → 缺失 / 冲突检查 → 人工成本与规则 → 确定性报价 → 主管审批 → 正式导出 → 人工确认发送 → 跟进。

**本地演示使用合成数据和规则提取，不代表真实模型准确率或商业效果。** 真实模型代码路径存在，未用真实 Key 验证；邮箱仅提供后续适配器接口；没有自动发送功能。

## 快速启动

需要 Node.js **22.13+** 和 npm（本次环境 Node 26.7.0 / npm 11.19.0）。依赖版本锁在 `package-lock.json`。

```bash
npm ci
cp .env.example .env
npm run seed
npm run dev
```

打开 **http://127.0.0.1:3210**。`npm run seed` 可反复执行，12 个场景对应 11 份不同询价，其中重复导入场景故意复用原询价。也可不 seed，登录后从“合成样本库”单独加载。

| 角色 | 邮箱 | 仅本地演示密码 |
|---|---|---|
| 销售 | sales@quovoy.demo | DemoSales!2026 |
| 主管 | manager@quovoy.demo | DemoManager!2026 |
| 另一组织（隔离测试） | isolation@quovoy.demo | DemoIsolation!2026 |

`.env` 不提交 Git。只有显式 `DEMO_MODE=true` 且 `QUOVOY_PUBLIC_DEPLOYMENT` 不为 `true` 才允许演示身份；切换为公开部署标记会拒绝历史演示会话。应用默认只监听本机回环地址。

## 五分钟演示

1. 销售登录，加载“完整单品询价”。左侧查看原文，右侧逐项核实或修改，再点确认。来源显示邮件行、PDF 页码或 Excel 工作表 / 单元格。
2. 进入“报价与审批”。100 件、单位成本 20、运费 200、其他费用 0；成本币种 CNY、报价币种 USD、加价率 25、汇率 7.2（**1 USD = 7.2 CNY**）。人工填写尚未过期的有效期、交期、付款条件、Incoterms。
3. “计算并保存新版本”，得到 **USD 381.94，毛利率 20%**；预览英文邮件，销售提交审批。没填齐可“暂存未完成报价”，刷新不丢数据，但不产生可审批金额。
4. 退出后以主管登录，核对并批准。正式客户报价只能导出仍有效的已批准版本；HTML 报价可在浏览器打印为 PDF。内部预览 / 导出有内部草稿标记；正式报价不含内部成本和毛利。
5. 演示场景中点击“我已发送报价”（仅模拟人工确认，没有任何邮件外发），生成一个三天后跟进任务。重复确认不重复创建；在跟进看板延期或完成。
6. 切回销售，修订规格 / 商业条款 / 英文邮件并保存：原批准版本失效，必须重新生成、提交和批准。

样本日期是固定演示资料；未来演示时请手动更新报价有效期。合成样本 02 展示真实 PDF + Excel 多产品；04 展示邮件和附件冲突；06 是扫描 PDF + CAD；07 是损坏文件；10 含恶意指令。它们不会执行附件脚本或改变权限。

## 配置与真实模型

默认 `AI_PROVIDER=demo`：根据实际原文的显式键值 / 表格做确定性规则提取。任意上传不套用固定样本；不认识的正文保留并进入人工补录。

```dotenv
AI_PROVIDER=structured
AI_API_KEY=<在本机秘密配置中填写>
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=<你的服务实际支持结构化输出的模型名称>
```

`live` 是 `structured` 的别名。实现调用兼容 Chat Completions 的 `response_format=json_schema`，使用严格 schema、45 秒超时、结构校验和真实来源核对。模型没有工具调用权，也不负责算价、审批或发送。无法找到原文的结果会取消模型给出的来源定位并标记待核实。模型不通时保留失败作业、原件和重试入口；人工已修改的数据不会被重试覆盖。配置真实模型会把所选询价文本发送给该模型服务，生产试点需使用客户已同意的数据范围。

模型模式的本地模拟响应、格式错误、超时与恢复已在测试中覆盖；**真实服务网络调用、实际费用和模型质量仍待验证**。`src/lib/email-ingress.ts` 提供后续认证邮箱适配器接口；没有 IMAP、Webhook 或 SMTP 凭证接入成功的宣称。

## 测试与样本

```bash
npm run samples     # 从脚本重建合成文件及逐字段期望来源
npm run typecheck
npm test            # Decimal、规则、完整业务、HTTP权限、并发恢复、文档解析
npm run build
npm start           # 本机 production build，端口仍为3210
```

实际命令、结果和浏览器证据在 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。试点材料及空白工时模板在 [docs/PILOT_KIT.md](docs/PILOT_KIT.md) 和 [docs/pilot-measurements.csv](docs/pilot-measurements.csv)。不要将合成样本的通过率当作真实模型准确率。

## 存储、权限和边界

- Next.js / React / TypeScript；SQLite（`node:sqlite`）+ 小型类型化 SQL repository；Decimal 金额计算。为减少本地安装和二进制兼容复杂度，MVP 未额外引入 ORM，数据库 SQL 与事务集中在 `src/lib/db.ts` / `service.ts`。
- 默认 `data/quovoy.sqlite`，原件 `data/files/<UUID>`；可设置绝对 `QUOVOY_DATA_DIR`。磁盘数据跨刷新 / 重启保留，不在 Git 中。备份请停止服务后一起备份完整 `data/`，或采用 SQLite 在线备份并同时备份附件；不要只复制活动数据库主文件而遗漏 WAL。
- 最小账号登录、scrypt 密码散列、HttpOnly SameSite 会话、销售 / 主管权限、组织归属过滤、原件鉴权下载、来源检查和审计日志由服务端执行。
- 10 MB / 文件、10 个上传文件、25 MB / 次；正文 250000 字符；PDF 100 页；XLSX 解压 40 MB、20 工作表、5000 行 / 单元格及100列上限。超限、损坏、扫描 / 不支持类型明确显示，原件保留或入口拒绝并说明。Excel 不执行宏 / 公式，不信任公式缓存值；邮件 HTML 不直接渲染。
- 类目规则在 `src/lib/category.ts`。无法判定的材质、成本、币种、交期不得猜测；尺寸确实不适用时人工填写“不适用：理由”。工程图仅由人确认尺寸、公差、工艺与可制造性。
- 金额采用十进制 HALF_UP 到两位。产品与费用单独计价，不把费用隐式分摊成产品单价；差额列入舍入调整行。报价总额与显示行合计一致。零总额毛利率显示不适用；没有税费或实时汇率推断。有效期按 Asia/Shanghai 日期判断。
- 这是单实例、受控试点 MVP，尚无密码重置、用户管理界面、SSO、完整计费、多副本作业调度和运维监控。审计可供内部追踪，尚不是防篡改审计存储。

## 受控部署路径（本次未公开部署）

1. 准备 Node 22.13+ 的单实例主机及持久磁盘；`npm ci && npm run build`。不要使用会丢失本地文件的无状态 / Edge 环境。
2. 新建独立数据目录，设置 `DEMO_MODE=false`、`QUOVOY_PUBLIC_DEPLOYMENT=true`、`APP_ORIGIN=https://实际域名`、`SECURE_COOKIES=true`。不要把演示数据库复制为客户生产库。
3. 通过秘密环境变量填写 `.env.example` 中的 `BOOTSTRAP_*`（销售 / 主管不同邮箱，密码至少14位），执行 `npm run bootstrap`。随后删除一次性初始化密码配置。该命令不覆盖已有账号。
4. 以服务管理器运行 `npm start`，HTTPS 反向代理到 `127.0.0.1:3210`；配置上传体积限制、备份、日志保留和访问控制。`APP_ORIGIN` 必须与外部同源 URL 一致。
5. 若迁往 Postgres：替换 `DatabaseSync` repository 与 SQL 占位符、布尔 / 时间 / JSON 类型及事务锁；保留组织范围、引用关系、版本快照、唯一幂等键、租约 attempt 隔离和回归测试。不要将本地多进程 SQLite 方案直接当成多租户多副本生产架构。
6. 生产首次部署、真实邮箱 / 模型调用及客户数据导入由 [docs/NEXT_STEPS.md](docs/NEXT_STEPS.md) 的外部条件推进。

进一步说明：[产品规格](docs/PRODUCT_SPEC.md) · [关键决策](docs/DECISIONS.md) · [进度](docs/PROGRESS.md) · [API](docs/API_CONTRACT.md) · [独立复核清单](docs/REVIEW_CHECKLIST.md)。
