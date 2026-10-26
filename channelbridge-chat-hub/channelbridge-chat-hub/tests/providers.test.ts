import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { parseTelegram, sendTelegram } from '../src/providers/telegram.ts';
import { parseMeta, verifyMetaSignature, insideCustomerWindow, sendWhatsApp, sendMessenger } from '../src/providers/meta.ts';
import type { Thread } from '../src/types.ts';

const baseThread: Thread = { id:'t', channel:'whatsapp', mode:'live', accountId:'abc', externalUserId:'15550000000',
 displayName:'Test', createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),lastInboundAt:new Date().toISOString() };

test('telegram accepts private text messages, ignores bot/group/non-text', () => {
  const valid = { update_id:100,message:{ message_id:9,date:1700000000,text:'hello',chat:{id:123,type:'private'},from:{first_name:'A',is_bot:false} } };
  assert.equal(parseTelegram(valid).length,1);
  assert.equal(parseTelegram({ ...valid, message: { ...valid.message, chat:{id:123,type:'group'} }}).length,0);
  assert.equal(parseTelegram({ update_id:100, message:{ message_id:1, chat:{id:5,type:'private'} }}).length,0);
});
test('WhatsApp normalization ignores other account and non-text events', () => {
  const payload = { object:'whatsapp_business_account',entry:[{ changes:[{ value:{ metadata:{phone_number_id:'p1'},
    contacts:[{wa_id:'77',profile:{name:'Buyer'}}],messages:[{id:'wamid-1',from:'77',type:'text',text:{body:'Hi'},timestamp:'1700000000'},
    {id:'image-1',from:'77',type:'image'}] } }] }] };
  assert.deepEqual(parseMeta(payload,'p1','').map(x=>x.text),['Hi']);
  assert.equal(parseMeta(payload,'p2','').length,0);
});
test('Messenger normalizes page messages, blocks echoes, wrong account', () => {
  const payload={ object:'page',entry:[{id:'page1',messaging:[
    {sender:{id:'u1'},recipient:{id:'page1'},message:{mid:'m1',text:'Hi'},timestamp:1700000000000},
    {sender:{id:'page1'},recipient:{id:'u1'},message:{mid:'m2',text:'echo',is_echo:true}}]}]};
  assert.equal(parseMeta(payload,'','page1').length,1);
  assert.equal(parseMeta(payload,'','page2').length,0);
});
test('Meta HMAC checks raw bytes and refuses missing signature or secret', () => {
  const raw=Buffer.from('{"test":true}');
  const header='sha256='+createHmac('sha256','secret').update(raw).digest('hex');
  assert.equal(verifyMetaSignature(raw,header,'secret'),true);
  assert.equal(verifyMetaSignature(Buffer.from('{}'),header,'secret'),false);
  assert.equal(verifyMetaSignature(raw,undefined,'secret'),false);
  assert.equal(verifyMetaSignature(raw,header,''),false);
});
test('Meta free-form replies have a conservative 24h cutoff', () => {
  assert.equal(insideCustomerWindow(new Date(Date.now()-1000).toISOString()),true);
  assert.equal(insideCustomerWindow(new Date(Date.now()-25*3600_000).toISOString()),false);
});
test('Telegram sends via Bot API and checks provider acknowledgement',async()=>{
  let body:unknown;
  const fake=async (_url: string | URL | Request,opts?:RequestInit)=>{
    body=JSON.parse(String(opts?.body));
    return new Response(JSON.stringify({ok:true,result:{message_id:123}}),{status:200});
  };
  assert.equal(await sendTelegram({...baseThread,channel:'telegram'},'answer','testtoken',fake as typeof fetch),'123');
  assert.deepEqual(body,{chat_id:'15550000000',text:'answer'});
});
test('WhatsApp and Messenger outgoing API payloads stay distinct',async()=>{
  const sent:Array<unknown>=[];
  const fake=async (_url: string | URL | Request,opts?:RequestInit)=>{
    sent.push(JSON.parse(String(opts?.body)));
    return new Response(JSON.stringify(sent.length===1?{messages:[{id:'wa-123'}]}:{message_id:'ms-456'}),{status:200});
  };
  assert.equal(await sendWhatsApp(baseThread,'hello','token','v26.0',fake as typeof fetch),'wa-123');
  assert.equal(await sendMessenger({...baseThread,channel:'messenger'},'hi','page-token','v26.0',fake as typeof fetch),'ms-456');
  assert.equal((sent[0] as {messaging_product:string}).messaging_product,'whatsapp');
  assert.equal((sent[1] as {messaging_type:string}).messaging_type,'RESPONSE');
});
