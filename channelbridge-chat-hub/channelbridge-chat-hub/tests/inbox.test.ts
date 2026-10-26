import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InboxStore } from '../src/storage.ts';
import { ChatHub } from '../src/service.ts';
import type { Incoming } from '../src/types.ts';

const incoming = (overrides:Partial<Incoming>={}):Incoming=>({mode:'live',channel:'telegram', accountId:'bot1',
 externalUserId:'user1',displayName:'First',providerMessageId:'msg1',text:'Hello',...overrides});

test('idempotent ingress: repeated webhook creates only one message', async()=>{
 const store=new InboxStore();await store.init();
 assert.equal((await store.receive(incoming())).inserted,true);
 assert.equal((await store.receive(incoming())).inserted,false);
 assert.equal(store.listThreads().length,1);
 assert.equal(store.listMessages(store.listThreads()[0].id).length,1);
});
test('cross-channel and cross-account identities never merge',async()=>{
 const store=new InboxStore();await store.init();
 await store.receive(incoming());
 await store.receive(incoming({channel:'whatsapp',accountId:'phone1'}));
 await store.receive(incoming({channel:'whatsapp',accountId:'phone2'}));
 await store.receive(incoming({mode:'demo'}));
 assert.equal(store.listThreads().length,4);
});
test('different users on the same channel remain separate', async()=>{
 const store=new InboxStore();await store.init();
 await store.receive(incoming());await store.receive(incoming({externalUserId:'user2',providerMessageId:'msg2'}));
 assert.equal(store.listThreads().length,2);
});
test('invalid incoming and outgoing content is rejected',async()=>{
 const store=new InboxStore();await store.init();
 await assert.rejects(store.receive(incoming({text:' '})));
 await store.receive(incoming());
 await assert.rejects(store.beginReply(store.listThreads()[0].id,''));
 await assert.rejects(store.beginReply(store.listThreads()[0].id,'x'.repeat(2001)));
});
test('failed provider replies are marked failed instead of silently accepted',async()=>{
 const store=new InboxStore();await store.init();await store.receive(incoming());
 const hub=new ChatHub(store,async()=>{throw new Error('Provider unavailable');});
 const id=store.listThreads()[0].id;
 await assert.rejects(hub.reply(id,'Reply'));
 assert.equal(store.listMessages(id).at(-1)?.status,'failed');
});
test('demo replies do not call provider APIs',async()=>{
 const store=new InboxStore();await store.init();let externalCalls=0;
 const hub=new ChatHub(store,async()=>{externalCalls++;return 'ok';});
 const id=await hub.simulateInbound('whatsapp','Test','Hello');
 await hub.reply(id,'Hello there');
 assert.equal(store.listMessages(id).at(-1)?.status,'sent');
 assert.equal(externalCalls,0);
});
test('durable JSON store survives reload and concurrent ingresses',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'cb-'));
 try {
  const file=join(directory,'inbox.json');const store=new InboxStore(file);await store.init();
  await Promise.all(Array.from({length:15},(_,i)=>store.receive(incoming({providerMessageId:`message-${i}`}))));
  const reloaded=new InboxStore(file);await reloaded.init();
  assert.equal(reloaded.listThreads().length,1);
  assert.equal(reloaded.listMessages(reloaded.listThreads()[0].id).length,15);
 } finally { await rm(directory,{recursive:true,force:true}); }
});
