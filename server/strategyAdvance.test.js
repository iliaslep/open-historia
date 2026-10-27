import assert from 'node:assert/strict';
import test from 'node:test';
import { createStrategyAdvance } from './strategyAdvance.js';
import { prepareSimulationOperation } from './simulation/clockCommand.js';
import { createStrategyChat } from './strategyChat.js';
const fixture=()=>{
  let pair={game:{country:'Germany',gameDate:'2016-12-08'},world:{polityOverrides:{Germany:{},France:{}}},meta:{id:'test',scenarioId:'default'},chat:[]};
  pair={...pair,...prepareSimulationOperation(pair,'start',{seed:7},'test')};
  let answer,run;const calls=[];
  const commit=(id,body,op)=>{const result=prepareSimulationOperation(pair,op,body,id);pair={...pair,...result};return result;};
  const ask=async input=>{calls.push(input);await run?.();const c=JSON.parse(input.context);return {text:typeof answer==='string'?answer:JSON.stringify(answer||{articles:[{id:c.articles[0].id,title:'Новый выпуск: правительство приступило к работе',body:'Государственные программы проходят очередной этап исполнения.'}],worldEvents:[]})};};
  const service=createStrategyAdvance({readGame:()=>({data:structuredClone(pair)}),commit,ask});
  return {pair:()=>pair,calls,answer:x=>answer=x,during:fn=>run=fn,commit,ask,send:()=>service({gameId:'test',model:'fixture',step:'week',expectedRevision:pair.world.simulation.revision})};
};
test('AI turn commits dates, mechanics and a newspaper atomically',async()=>{
  const f=fixture(),before=structuredClone(f.pair());await f.send();
  assert.equal(f.pair().game.gameDate,'2016-12-15');assert.equal(f.pair().world.simulation.revision,7);
  assert.equal(f.pair().world.strategy.story.news.some(n=>n.source==='ai'),true);
  assert.equal(f.calls[0].purpose,'simulation');assert.equal(before.game.gameDate,'2016-12-08');
});
test('invalid, failed, cancelled or stale inference never advances time or commits a second turn',async()=>{
  for(const value of ['incomplete JSON',JSON.stringify({articles:[{id:'not-present',title:'x',body:'x'}],worldEvents:[]})]) {
    const f=fixture(),before=structuredClone(f.pair());f.answer(value);await assert.rejects(f.send);assert.deepEqual(f.pair(),before);
  }
  const f=fixture(),before=structuredClone(f.pair());f.during(()=>{throw new Error('aborted');});await assert.rejects(f.send,/aborted/);assert.deepEqual(f.pair(),before);
  f.during(()=>f.commit('test',{expectedRevision:f.pair().world.simulation.revision,step:'day'},'advance'));
  await assert.rejects(f.send,e=>e.status===409);assert.equal(f.pair().game.gameDate,'2016-12-09');
});
test('a free-text plan flows through existing conversation proposals, real deadlines, memory and newspaper',async()=>{
  const f=fixture();
  const action={type:'initiative',title:'Космическое агентство',description:'Организовать агентство и подготовить научный план первого этапа.',budget:1000,days:7,focus:'science',difficulty:'ambitious',visibility:'public'};
  const chat=createStrategyChat({readGame:()=>({data:structuredClone(f.pair())}),commit:f.commit,ask:async()=>({text:JSON.stringify({reply:'Подготовим первый этап.',stance:'accept',actions:[action]})})});
  await chat({gameId:'test',model:'fixture',prompt:'Хочу создать космическое агентство',channel:'decisions',target:'',expectedRevision:0});
  assert.equal(f.pair().world.strategy.story,undefined);
  f.commit('test',{expectedRevision:1,messageId:'strategy-message-1-leader'},'chat-apply');
  assert.equal(f.pair().world.strategy.story.initiatives[0].status,'active');await f.send();
  assert.notEqual(f.pair().world.strategy.story.initiatives[0].status,'active');
  assert.ok(f.pair().world.strategy.story.facts.some(f=>f.title==='Космическое агентство'));
});

test('a foreign delegation can negotiate a free initiative but cannot execute private or third-party orders',async()=>{
  const f=fixture(),action={type:'initiative',title:'Международный научный конгресс',description:'Обсудить совместную конференцию и подготовить проект повестки.',budget:1000,days:7,focus:'diplomacy',difficulty:'ambitious',visibility:'public',target:'France'};
  let response={reply:'Обсудим условия.',stance:'counter',actions:[action]};
  const chat=createStrategyChat({readGame:()=>({data:structuredClone(f.pair())}),commit:f.commit,ask:async()=>({text:JSON.stringify(response)})});
  const send=()=>chat({gameId:'test',model:'fixture',prompt:'Предлагаем международный научный конгресс',channel:'diplomacy',target:'France',expectedRevision:f.pair().world.simulation.revision});
  await send();f.commit('test',{expectedRevision:1,messageId:'strategy-message-1-leader'},'chat-apply');
  assert.equal(f.pair().world.strategy.story.initiatives[0].target,'France');
  const before=structuredClone(f.pair());response={...response,actions:[{...action,visibility:'private'}]};await assert.rejects(send);assert.deepEqual(f.pair(),before);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { commitSimulationOperation,recoverSimulationClock } from './simulation/clockStore.js';
test('a crash after world projection recovers the entire AI turn without repeating NPC spending',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'oh-story-recovery-')),directory=path.join(root,'test');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(directory);
  const f=fixture(),pair=f.pair();
  for(const [key,file]of [['game','game.json'],['world','world.json'],['meta','game-instance.json']])fs.writeFileSync(path.join(directory,file),JSON.stringify(pair[key]));
  const body={expectedRevision:0,step:'week',response:{articles:[],worldEvents:[{country:'France',title:'Научная программа',body:'Франция выделила средства на подготовку исследований.',focus:'science',direction:'advance'}]}};
  const expected=prepareSimulationOperation(pair,'news-advance',body,'test');
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
    import fs from 'node:fs';import path from 'node:path';
    import {commitSimulationOperation} from ${JSON.stringify(new URL('./simulation/clockStore.js',import.meta.url).href)};
    const rename=fs.renameSync;fs.renameSync=(a,b)=>{rename(a,b);if(path.basename(b)==='world.json')process.exit(86);};
    commitSimulationOperation(${JSON.stringify(directory)},'news-advance',${JSON.stringify(body)});
  `],{encoding:'utf8'});
  assert.equal(result.status,86,result.stderr);assert.equal(recoverSimulationClock(directory),true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory,'world.json'),'utf8')),expected.world);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'game.json'),'utf8')).gameDate,'2016-12-15');
  assert.throws(()=>commitSimulationOperation(directory,'news-advance',body),e=>e.status===409);
});
