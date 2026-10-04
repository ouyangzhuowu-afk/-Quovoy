export type Role = 'sales' | 'manager';
export type User = { id: string; organizationId: string; name: string; email: string; role: Role };
export type SourceSegment = { locator: string; text: string };
export type ParsedDocument = { filename: string; kind: 'text'|'eml'|'pdf'|'xlsx'|'unsupported'; status: 'parsed'|'manual'|'failed'; text: string; segments: SourceSegment[]; warnings: string[]; bytes?: Buffer; mimeType?: string };
export type ExtractionDocument = { id: string; filename: string; segments: SourceSegment[]; text: string };
export type FieldInput = { key: string; rawValue: string; normalizedValue: string; sourceDocumentId: string|null; sourceLocator: string|null; excerpt: string|null; method: 'rule'|'model'|'manual'; verificationReason: string|null };
export type ExtractionResult = { fields: FieldInput[]; items: { fields: FieldInput[] }[]; warnings: string[] };
export interface AIProvider { name: string; extract(documents: ExtractionDocument[]): Promise<ExtractionResult> }
export type Field = FieldInput & { id: string; itemId: string|null; confirmedValue: string|null; confirmed: boolean; editedBy: string|null; editedAt: string|null };
export type Issue = { id: string; severity: 'blocker'|'warning'; code: string; message: string; fieldIds: string[]; sourceLocations: string[]; resolved?: boolean };
export type RFQStatus = 'new'|'waiting_customer'|'waiting_supplier'|'pending_approval'|'quoted'|'following_up'|'won'|'lost'|'paused';
export type RFQSummary = { id: string; customer: string; createdAt: string; status: RFQStatus; ownerName: string; ownerId: string; issues: number; blockers: number; itemCount: number; synthetic: boolean; revision: number };
export type QuoteInput = { customerName?: string; unitCosts: Record<string,string>; freight: string; otherCosts: string; markupPercent: string; exchangeRate: string; costCurrency: string; quoteCurrency: string; validUntil: string; deliveryTerms: string; paymentTerms: string; incoterms: string; emailSubject?: string; emailBody?: string };
export type QuoteLine = { itemId: string; name: string; model: string; quantity: string; unit: string; unitCost: string; costTotal: string; saleTotal: string; specifications: string };
export type QuoteTotals = { lines: QuoteLine[]; freightCost: string; otherCost: string; freightSale: string; otherSale: string; costTotal: string; saleCostCurrency: string; total: string; grossMarginPercent: string; roundingAdjustment: string };
export type Quote = { id: string; rfqId: string; version: number; rfqRevision: number; status: 'draft'|'pending'|'returned'|'approved'|'superseded'; input: QuoteInput; totals: QuoteTotals; emailSubject: string; emailBody: string; createdAt: string; createdBy: string; approvedAt: string|null; sentAt: string|null; returnReason: string|null };
export type FollowUpTask = { id: string; rfqId: string; quoteId: string|null; title: string; ownerId: string; ownerName: string; dueAt: string; status: 'pending'|'completed'; completedAt: string|null; customer: string };
export type RFQDetail = RFQSummary & { quoteDraft?: QuoteInput|null; fields: Field[]; items: {id: string; position: number; fields: Field[]}[]; documents: {id: string; filename: string; kind: string; status: string; text: string; segments: SourceSegment[]; warnings: string[]}[]; issuesList: Issue[]; quotes: Quote[]; tasks: FollowUpTask[]; jobs: {id: string; status: string; attempts: number; error: string|null}[]; clarificationDraft: string; supplierDraft: string; reviewSeconds: number; audit: {id:string; action:string; actorName:string; createdAt:string; detail:string}[] };
export const RFQ_LABELS: Record<RFQStatus,string> = {new:'新询价',waiting_customer:'等客户补充',waiting_supplier:'等供应商',pending_approval:'待审批',quoted:'已报价',following_up:'跟进中',won:'赢单',lost:'丢单',paused:'暂停'};
export const FIELD_LABELS: Record<string,string> = {customer:'客户名称',contact:'联系人',productName:'产品名称',model:'型号',quantity:'数量',unit:'单位',material:'材质',dimensions:'尺寸',technicalParameters:'技术参数',targetDelivery:'目标交期',destination:'目的地',incoterms:'Incoterms',paymentTerms:'付款条件',currency:'币种',validity:'报价有效期'};
export const RFQ_FIELD_KEYS = ['customer','contact','targetDelivery','destination','incoterms','paymentTerms','currency','validity'];
export const ITEM_FIELD_KEYS = ['productName','model','quantity','unit','material','dimensions','technicalParameters'];
export function fieldValue(field: Field | undefined): string { return field ? (field.confirmedValue ?? field.normalizedValue) : ''; }
