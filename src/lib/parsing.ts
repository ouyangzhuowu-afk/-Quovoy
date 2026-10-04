import path from 'node:path';
import { simpleParser } from 'mailparser';
import ExcelJS from 'exceljs';
import type { ParsedDocument, SourceSegment } from './contracts';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT = 250_000;
const MAX_SEGMENTS = 5_000;
const MAX_EXPANDED_ZIP = 40 * 1024 * 1024;
const MIME: Record<string, string> = { '.eml': 'message/rfc822', '.pdf': 'application/pdf', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.txt': 'text/plain' };

function lines(text: string, prefix: string): SourceSegment[] {
  return text.replace(/\r\n?/g, '\n').split('\n').map((line, i) => ({locator: `${prefix}${i + 1}`, text: line})).filter(s => s.text.trim());
}
function bounded(document: ParsedDocument): ParsedDocument {
  if (document.text.length > MAX_TEXT || document.segments.length > MAX_SEGMENTS || document.segments.reduce((sum,s)=>sum+s.text.length,0)>MAX_TEXT) {
    let remaining=MAX_TEXT;
    const segments: SourceSegment[]=[];
    for (const segment of document.segments.slice(0,MAX_SEGMENTS)) {
      if (!remaining) break;
      const text=segment.text.slice(0,remaining);remaining-=text.length;segments.push({...segment,text});
    }
    return {...document, status: 'manual', text: document.text.slice(0, MAX_TEXT), segments, warnings: [...document.warnings, '内容超出解析上限，展示仅为部分原文；完整原文件已保留，请人工审核。']};
  }
  return document;
}
export function parseText(text: string): ParsedDocument {
  return bounded({filename: 'pasted-email.txt', kind: 'text', status: text.trim() ? 'parsed' : 'manual', text, segments: lines(text, 'text:line:'), warnings: text.trim() ? [] : ['正文为空，请补充原文或人工录入。'], bytes: Buffer.from(text), mimeType: 'text/plain'});
}

/** Preflight the central directory before an XLSX parser can inflate a ZIP bomb. */
function inspectZip(bytes: Buffer): void {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('Excel 文件不是有效的 XLSX 压缩包');
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16), total = 0;
  if (count > 2000 || count === 65535) throw new Error('Excel 工作簿内容过多，请拆分后重试');
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Excel 压缩包目录损坏');
    const flags = bytes.readUInt16LE(offset + 8);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    total += size;
    if (flags & 1) throw new Error('加密 Excel 不支持解析，请提供未加密副本或人工录入');
    if (/vbaProject\.bin$/i.test(name)) throw new Error('包含宏的工作簿不支持解析，请提供不含宏的 XLSX');
    if (size === 0xffffffff || total > MAX_EXPANDED_ZIP) throw new Error('Excel 解压后超出 40 MB 上限，请拆分后重试');
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

export async function parseDocument(bytes: Buffer, filename: string, mimeType?: string): Promise<ParsedDocument[]> {
  return parseFile(bytes, filename, mimeType, 0, {count: 0, bytes: 0});
}
async function parseFile(bytes: Buffer, originalName: string, mimeType: string | undefined, depth: number, budget: {count: number; bytes: number}): Promise<ParsedDocument[]> {
  const filename = path.basename(originalName.replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').slice(0, 240) || 'unnamed-attachment';
  const extension = path.extname(filename).toLowerCase();
  const kind = extension === '.txt' ? 'text' : ['.eml', '.pdf', '.xlsx'].includes(extension) ? extension.slice(1) as 'eml' | 'pdf' | 'xlsx' : 'unsupported';
  const base: ParsedDocument = {filename, kind, status: 'parsed', text: '', segments: [], warnings: [], bytes, mimeType: MIME[extension] || mimeType || 'application/octet-stream'};
  budget.count++; budget.bytes += bytes.length;
  if (bytes.length > MAX_FILE_BYTES) return [{...base, status: 'failed', warnings: ['文件超过 10 MB 上限，请拆分后重试；原文件已保留。']}];
  if (budget.count > 40 || budget.bytes > MAX_FILE_BYTES * 3 || depth > 2) return [{...base, status: 'manual', warnings: ['邮件附件数量、总容量或嵌套层级超限，原附件已保留，请人工审核。']}];
  if (!bytes.length) return [{...base, status: 'failed', warnings: ['文件为空，请重新导出原文件并重试。']}];
  try {
    if (kind === 'text') return [{...parseText(bytes.toString('utf8')), filename, bytes}];
    if (kind === 'eml') {
      if (!/^(From|To|Date|Subject|MIME-Version|Content-Type):/im.test(bytes.subarray(0, 16384).toString('utf8'))) throw new Error('EML 缺少邮件头，请重新导出邮件或粘贴正文');
      const mail = await simpleParser(bytes, {skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true, maxHtmlLengthToParse: MAX_TEXT});
      const body = mail.text || '';
      const email = bounded({...base, text: body, segments: lines(body, 'email:line:'), status: body.trim() ? 'parsed' : 'manual', warnings: body.trim() ? [] : ['邮件没有可提取正文，附件将单独处理，请人工审核。']});
      const results = [email];
      for (const [i, attachment] of mail.attachments.entries()) {
        const docs = await parseFile(attachment.content, attachment.filename || `attachment-${i + 1}`, attachment.contentType, depth + 1, budget);
        results.push(...docs);
      }
      return results;
    }
    if (kind === 'pdf') {
      if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('PDF 文件头无效，文件可能损坏');
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({data: new Uint8Array(bytes), isEvalSupported: false});
      try {
        const info = await parser.getInfo();
        if (info.total > 100) return [{...base, status: 'manual', warnings: ['PDF 超过 100 页解析上限，请拆分后重试或人工录入。']}];
        const result = await parser.getText();
        const segments = result.pages.flatMap(page => lines(page.text, `page:${page.num}:line:`));
        const text = result.pages.map(page => page.text).join('\n\n');
        return [bounded({...base, text, segments, status: text.trim() ? 'parsed' : 'manual', warnings: text.trim() ? ['仅提取 PDF 文字；工程图尺寸、公差及工艺仍需人工确认。'] : ['未解析：PDF 无可提取文字，可能是扫描件；未运行 OCR，请查看原件并人工补录。']})];
      } finally { await parser.destroy(); }
    }
    if (kind === 'xlsx') {
      inspectZip(bytes);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
      const segments: SourceSegment[] = [];
      let formulaCount = 0, oversized = false;
      for (const sheet of workbook.worksheets) {
        if (sheet.rowCount > 5000 || sheet.columnCount > 100 || workbook.worksheets.length > 20) { oversized = true; break; }
        sheet.eachRow(row => row.eachCell(cell => {
          if (segments.length >= MAX_SEGMENTS) { oversized = true; return; }
          const value = cell.value;
          let text = cell.text;
          if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
            formulaCount++;
            text = '[公式未执行，需人工核对]';
          }
          if (text.trim()) segments.push({locator: `'${sheet.name.replace(/'/g, "''")}'!${cell.address}`, text});
        }));
      }
      const warnings = formulaCount ? [`${formulaCount} 个公式单元格未执行，也未信任缓存值；请人工输入已核对结果。`] : [];
      if (oversized) warnings.push('工作簿超过 20 工作表、5000 行、100 列或 5000 单元格上限，展示仅为部分原文，请人工审核。');
      if (!segments.length) warnings.push('工作簿没有可提取内容，请人工录入。');
      return [bounded({...base, text: segments.map(s => `${s.locator}\t${s.text}`).join('\n'), segments, status: oversized || !segments.length ? 'manual' : 'parsed', warnings})];
    }
    return [{...base, status: 'manual', warnings: ['未解析：该附件类型暂不支持。原文件已保留，图片、CAD 和其他附件请人工审核。']}];
  } catch (error) {
    // Never echo uploaded content or parser stack traces into logs / user errors.
    const known = error instanceof Error && /^(Excel |EML |PDF |加密 Excel|包含宏)/.test(error.message);
    return [{...base, status: 'failed', warnings: [known ? (error as Error).message : '解析失败：文件可能损坏、加密或格式不兼容。请重新导出并重试，或保留原件人工补录。']}];
  }
}
