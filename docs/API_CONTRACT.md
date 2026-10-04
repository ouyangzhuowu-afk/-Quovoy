# 内部 API 契约
JSON 成功直接返回对象，错误 {error,code} + 对应 HTTP status。Cookie session，客户端同源 fetch。
- GET /api/session => {user:User|null,demoMode:boolean}
- POST /api/login {email,password} => {user}; POST /api/logout
- GET /api/users => {users:User[]} 组织内用户
- GET /api/rfqs => {rfqs:RFQSummary[],stats:{total,blockers,pendingApproval,overdue}}
- POST /api/rfqs multipart: text (可选), files (多个), synthetic ('true' 演示样本) => {rfqId,duplicate:boolean,message?}
- GET /api/rfqs/:id => RFQDetail
- PATCH /api/rfqs/:id {status?,ownerId?}
- POST /api/rfqs/:id/items => {id}
- PATCH /api/rfqs/:id/fields/:fieldId {value:string,confirmed:boolean}
- POST /api/rfqs/:id/review-time {seconds:number} => {reviewSeconds}
- POST /api/rfqs/:id/retry => {message}
- GET /api/documents/:id => 文件下载（组织鉴权）
- POST /api/rfqs/:id/quotes QuoteInput => Quote (新版本)
- POST /api/quotes/:id/submit => Quote; POST /api/quotes/:id/approve => Quote; POST /api/quotes/:id/return {reason} => Quote
- GET /api/quotes/:id/export?kind=internal|formal => 下载 HTML 报价（可浏览器打印 PDF）
- POST /api/quotes/:id/sent => {taskId,alreadySent}
- GET /api/tasks => {tasks:FollowUpTask[]}
- POST /api/tasks {rfqId,title,ownerId,dueAt} => {id}
- PATCH /api/tasks/:id {status?,dueAt?,ownerId?} => {ok:true}
- GET /api/samples => {samples:[{id,title,description,files:string[]}]}
- POST /api/samples/:id/import => {rfqId,duplicate}
角色：sales 创建修改报价/字段/询价，manager 审批/退回；二者读、任务操作、导出、确认发送。演示账号 sales@quovoy.demo / manager@quovoy.demo 密码 DemoSales!2026 / DemoManager!2026（后端仅显式演示开关、本地环境）。
字段和记录详见 src/lib/contracts.ts。UI 页面在单一客户端实现可使用 /?rfq=ID 持久定位，刷新 session 恢复。
- POST /api/rfqs/:id/quote-draft QuoteInput => {ok:true}: 暂存不完整成本/规则，不计算金额，不可审批；旧审批失效。RFQDetail.quoteDraft 在刷新后恢复，成功生成版本后清除暂存。
