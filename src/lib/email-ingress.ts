import type {User} from './contracts';
import {importRFQ} from './service';
/** Future authenticated mailbox adapters produce RFC822 bytes; no mail credentials or send API. */
export interface EmailIngressAdapter {
 readonly name:string;
 readInbound(cursor:string|null):Promise<{messages:{externalId:string;rfc822:Buffer}[];nextCursor:string|null}>;
}
/** Caller must bind an authenticated, authorized sales account; IDs never come from message contents. */
export async function ingestInbound(user:User,message:{externalId:string;rfc822:Buffer}) {
 // A stable filename permits existing content-hash deduplication on repeated delivery.
 return importRFQ(user,'',[{filename:'forwarded-message.eml',bytes:message.rfc822,mimeType:'message/rfc822'}]);
}
