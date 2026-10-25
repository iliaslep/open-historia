import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createStrategyChat } from './strategyChat.js';
import { prepareSimulationOperation } from './simulation/clockCommand.js';
import { commitSimulationOperation, recoverSimulationClock } from './simulation/clockStore.js';
import { nativeThreads, validateNativeChats } from './simulation/conversations.js';

const initial = () => {
  const pair = { game: { country: 'Germany', gameDate: '2016-12-08' }, world: { polityOverrides: { Germany: {}, France: {}, Russia: {} } }, meta: { id: 'test', scenarioId: 'default' }, chat: [{ id: 'legacy', messages: [{ role: 'user', content: 'Старая переписка' }] }] };
  return { ...pair, ...prepareSimulationOperation(pair, 'start', { seed: 7 }, 'test') };
};
const fixture = () => {
  let pair = initial(), answer = { reply: 'Предлагаю налоговую реформу.', stance: 'accept', actions: [{ type: 'tax', value: 40 }] }, inference;
  const inputs = [];
  const commit = (id, body, operation) => {
    assert.equal(id, 'test');
    const result = prepareSimulationOperation(pair, operation, body, id);
    pair = { ...pair, ...result }; return { gameId: id, ...result };
  };
  const service = createStrategyChat({ readGame: () => ({ data: structuredClone(pair) }), commit, ask: async input => {
    inputs.push(input);
    if (inference) await inference();
    return { text: typeof answer === 'string' ? answer : JSON.stringify(answer), usage: { input_tokens: 20, output_tokens: 10 } };
  } });
  const send = (channel = 'decisions', target = '', prompt = 'Повысить налоги до 40 %') => service({ gameId: 'test', channel, target, prompt, model: 'unit', expectedRevision: pair.world.simulation.revision });
  const operate = (operation, body) => commit('test', { expectedRevision: pair.world.simulation.revision, ...body }, operation);
  const latest = () => nativeThreads(pair.chat).at(-1).messages.at(-1);
  return { send, operate, latest, inputs, pair: () => pair, answer: value => { answer = value; }, during: value => { inference = value; } };
};

test('a free-text decision becomes a priced proposal, applies once, and completes on its real deadline', async () => {
  const f = fixture(), before = structuredClone(f.pair());
  await f.send();
  assert.deepEqual(f.pair().world.strategy, before.world.strategy);
  assert.deepEqual(f.pair().world.simulation.rng, before.world.simulation.rng);
  assert.equal(f.latest().proposal.cost.capital, 10);
  assert.equal(f.pair().game.gameDate, before.game.gameDate);
  const messageId = f.latest().id;
  f.operate('chat-apply', { messageId });
  assert.equal(f.pair().world.strategy.countries.Germany.capital, 50);
  assert.equal(f.latest().proposal.status, 'applied');
  assert.equal(f.pair().world.strategy.countries.Germany.tax, 3800);
  assert.throws(() => f.operate('chat-apply', { messageId }));
  f.operate('advance', { step: 'week' });
  assert.equal(f.pair().world.strategy.countries.Germany.tax, 4000);
  assert.deepEqual(f.pair().chat[0], before.chat[0]);
});

test('negotiated aid transfers both balances exactly and trade changes both economies', async () => {
  const f = fixture();
  f.answer({ reply: 'Предлагаем помощь и торговлю.', stance: 'counter', actions: [{ type: 'aid', target: 'France', value: 500 }, { type: 'trade', target: 'France' }] });
  await f.send('diplomacy', 'France', 'Какие условия вы предлагаете?');
  assert.equal(f.latest().proposal.cost.treasury, 500);
  const before = structuredClone(f.pair().world.strategy.countries);
  f.operate('chat-apply', { messageId: f.latest().id });
  assert.equal(f.pair().world.strategy.countries.Germany.treasury, before.Germany.treasury - 500);
  assert.equal(f.pair().world.strategy.countries.France.treasury, before.France.treasury + 500);
  assert.equal(f.pair().world.strategy.treaties.length, 1);
});

test('the delegation can refuse without spending resources or signing obligations', async () => {
  const f = fixture(), before = structuredClone(f.pair().world.strategy);
  f.answer({ reply: 'Мы отказываемся от условий.', stance: 'reject', actions: [] });
  await f.send('diplomacy', 'France', 'Подпишите договор');
  assert.deepEqual(f.pair().world.strategy, before);
  assert.equal(f.latest().proposal, undefined);
  assert.match(f.latest().content, /отказываемся/);
});

test('blocked resources or hostile relations cannot be overridden by an AI acceptance or a partial batch', async () => {
  const f = fixture(), before = structuredClone(f.pair().world.strategy);
  f.answer({ reply: 'Согласны.', stance: 'accept', actions: [{ type: 'aid', target: 'France', value: 500 }, { type: 'aid', target: 'France', value: 1000000 }] });
  await f.send('diplomacy', 'France');
  assert.equal(f.latest().proposal.status, 'blocked');
  assert.match(f.latest().proposal.error, /средств/);
  assert.deepEqual(f.pair().world.strategy, before);
  assert.throws(() => f.operate('chat-apply', { messageId: f.latest().id }));
  f.pair().world.strategy.countries.Germany.relations.France = -50;
  f.answer({ reply: 'Согласны.', stance: 'accept', actions: [{ type: 'trade', target: 'France' }] });
  await f.send('diplomacy', 'France');
  assert.equal(f.latest().proposal.status, 'blocked');
  assert.equal(f.pair().world.strategy.treaties.length, 0);
});

test('stale inference and proposals never land after another turn or decision', async () => {
  const f = fixture();
  f.during(() => f.operate('advance', { step: 'day' }));
  await assert.rejects(() => f.send(), e => e.status === 409);
  assert.equal(nativeThreads(f.pair().chat).length, 0);
  f.during(null); await f.send();
  const messageId = f.latest().id;
  f.operate('advance', { step: 'day' });
  const before = structuredClone(f.pair());
  assert.throws(() => f.operate('chat-apply', { messageId }), /устарело/);
  assert.deepEqual(f.pair(), before);
});

test('invalid model schemas, foreign actors, excessive values and transport failures change nothing', async () => {
  const f = fixture(), before = structuredClone(f.pair());
  for (const answer of ['not JSON', { reply: 'ok', stance: 'accept', actions: [{ type: 'world', value: 100 }] },
    { reply: 'ok', stance: 'accept', actions: [{ type: 'tax', value: 99 }] },
    { reply: 'ok', stance: 'accept', actions: [{ type: 'tax', value: 40, target: 'France' }] },
    { reply: 'ok', stance: 'accept', actions: [{ type: 'aid', value: 500, target: 'Russia' }] },
    { reply: 'ok', stance: 'reject', actions: [{ type: 'trade', target: 'France' }] }]) {
    f.answer(answer);
    await assert.rejects(() => f.send('diplomacy', 'France'));
    assert.deepEqual(f.pair(), before);
  }
  f.during(() => { throw new Error('network unavailable'); });
  await assert.rejects(() => f.send(), /network unavailable/);
  assert.deepEqual(f.pair(), before);
});

test('cabinet and country conversations keep separate memory and do not expose private knowledge to foreign delegates', async () => {
  const f = fixture();
  f.answer({ reply: 'Секретный внутренний план.', stance: 'discuss', actions: [] });
  await f.send('decisions', '', 'Кабинетный секрет');
  f.answer({ reply: 'Французский разговор.', stance: 'discuss', actions: [] });
  await f.send('diplomacy', 'France', 'Только для Франции');
  f.answer({ reply: 'Русский разговор.', stance: 'discuss', actions: [] });
  await f.send('diplomacy', 'Russia', 'Другие переговоры');
  const context = JSON.parse(f.inputs.at(-1).context);
  assert.equal(context.ownCountry, undefined); assert.equal(context.reports, undefined); assert.equal(context.projects, undefined);
  assert.equal(context.history.length, 0);
  for (const secret of ['Кабинетный секрет', 'Секретный внутренний план', 'Только для Франции', 'readiness', 'treasury']) assert.equal(f.inputs.at(-1).context.includes(secret), false);
  await f.send('diplomacy', 'France', 'Продолжаем');
  assert.equal(JSON.parse(f.inputs.at(-1).context).history.length, 2);
  assert.equal(nativeThreads(f.pair().chat).length, 3);
});

test('diplomatic signals consume support, have a daily limit and survive JSON restart', async () => {
  const f = fixture(); f.answer({ reply: 'Поддержим сближение.', stance: 'accept', actions: [{ type: 'dialogue', target: 'France', value: 1 }] });
  await f.send('diplomacy', 'France'); f.operate('chat-apply', { messageId: f.latest().id });
  assert.equal(f.pair().world.strategy.countries.Germany.relations.France, 2);
  assert.equal(f.pair().world.strategy.countries.Germany.capital, 58);
  await f.send('diplomacy', 'France'); assert.equal(f.latest().proposal.status, 'blocked');
  f.operate('advance', { step: 'day' }); await f.send('diplomacy', 'France');
  const pair = JSON.parse(JSON.stringify(f.pair()));
  const applied = prepareSimulationOperation(pair, 'chat-apply', { expectedRevision: pair.world.simulation.revision, messageId: f.latest().id }, 'test');
  assert.equal(applied.world.strategy.countries.Germany.relations.France, 4);
});

test('stored chat corruption is rejected, messages are bounded and unrelated legacy conversations survive', async () => {
  const f = fixture(); f.answer({ reply: 'Уточните детали.', stance: 'discuss', actions: [] });
  for (let i = 0; i < 23; i++) await f.send();
  assert.equal(nativeThreads(f.pair().chat)[0].messages.length, 40);
  const bad = structuredClone(f.pair().chat);
  nativeThreads(bad)[0].messages[0].time = '9999-01-01';
  assert.throws(() => validateNativeChats(bad, f.pair().world.strategy, f.pair().game.gameDate));
  assert.equal(f.pair().chat[0].id, 'legacy');
});

for (const target of ['.simulation-clock-journal.json', 'game.json', 'world.json', 'chat.json', 'game-instance.json']) {
  test(`chat and budget recover together after a crash replacing ${target}`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-native-chat-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directory = path.join(root, 'test'), pair = initial(); fs.mkdirSync(path.join(directory, 'storage'), { recursive: true });
    for (const [key, file] of [['game', 'game.json'], ['world', 'world.json'], ['meta', 'game-instance.json'], ['chat', 'storage/chat.json']]) fs.writeFileSync(path.join(directory, file), JSON.stringify(pair[key]));
    commitSimulationOperation(directory, 'chat-record', { channel: 'diplomacy', target: 'France', prompt: 'Помощь 500 млн евро', expectedRevision: 0,
      response: { reply: 'Примем помощь.', stance: 'accept', actions: [{ type: 'aid', target: 'France', value: 500 }] } });
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs'; import path from 'node:path';
      import {commitSimulationOperation} from ${JSON.stringify(new URL('./simulation/clockStore.js', import.meta.url).href)};
      const rename=fs.renameSync;fs.renameSync=(a,b)=>{rename(a,b);if(path.basename(b)===${JSON.stringify(target)})process.exit(86);};
      commitSimulationOperation(${JSON.stringify(directory)},'chat-apply',{expectedRevision:1,messageId:'strategy-message-1-leader'});
    `], { encoding: 'utf8' });
    assert.equal(result.status, 86, result.stderr);
    assert.equal(recoverSimulationClock(directory), true);
    const world = JSON.parse(fs.readFileSync(path.join(directory, 'world.json'), 'utf8'));
    const chat = JSON.parse(fs.readFileSync(path.join(directory, 'storage/chat.json'), 'utf8'));
    assert.equal(world.strategy.countries.Germany.treasury, pair.world.strategy.countries.Germany.treasury - 500);
    assert.equal(world.strategy.countries.France.treasury, pair.world.strategy.countries.France.treasury + 500);
    assert.equal(nativeThreads(chat)[0].messages.at(-1).proposal.status, 'applied');
    assert.throws(() => commitSimulationOperation(directory, 'chat-apply', { expectedRevision: 1, messageId: 'strategy-message-1-leader' }), e => e.status === 409);
  });
}

test('AI alternatives are individually priced, one choice invalidates the others, new commands retain engine authority', async()=>{
  const f=fixture(),before=structuredClone(f.pair().world.strategy);
  f.answer({reply:'Три направления политики.',stance:'discuss',actions:[],suggestions:[
    {title:'Интеграция',reason:'Ускоряет адаптацию, но связывает казну.',actions:[{type:'migration_fund',value:10}]},
    {title:'Разведка',reason:'Качество оценок выше, результат через 14 дней.',actions:[{type:'spy_upgrade'}]},
    {title:'Недоступный бюджет',reason:'Недостаточно ресурсов.',actions:[{type:'migration_fund',value:1000000}]}]});
  await f.send('decisions','','Предложи альтернативы');
  assert.deepEqual(f.pair().world.strategy,before);
  const messages=nativeThreads(f.pair().chat).at(-1).messages,options=messages.filter(m=>m.proposal);
  assert.equal(options.length,3);assert.equal(options[0].proposal.cost.treasury,10);assert.equal(options[1].proposal.cost.treasury,640);assert.equal(options[2].proposal.status,'blocked');
  f.operate('chat-apply',{messageId:options[0].id});
  assert.equal(f.pair().world.strategy.migration.countries.Germany.fund,10);
  assert.equal(f.pair().world.strategy.countries.Germany.treasury,before.countries.Germany.treasury-10);
  assert.throws(()=>f.operate('chat-apply',{messageId:options[1].id}),/устарело/);
});

test('delegations cannot command migration or spies; malformed alternatives cannot bypass proposal validation',async()=>{
  const f=fixture(),before=structuredClone(f.pair());
  for(const answer of [
    {reply:'ok',stance:'discuss',actions:[],suggestions:[{title:'x',reason:'x',actions:[{type:'spy_deploy',target:'Russia'}]}]},
    {reply:'ok',stance:'accept',actions:[{type:'migration_quota',value:500}]},
    {reply:'ok',stance:'accept',actions:[{type:'spy_turn',target:'France',value:2}]}]) {
    f.answer(answer);await assert.rejects(()=>f.send('diplomacy','France'));assert.deepEqual(f.pair(),before);
  }
  for(const suggestions of [new Array(4).fill({title:'x',reason:'x',actions:[{type:'industry'}]}),[{title:'x',reason:'x',actions:[]}],[{title:'x',reason:'x',actions:[{type:'migration_fund',value:-1}]}]]) {
    f.answer({reply:'ok',stance:'discuss',actions:[],suggestions});await assert.rejects(()=>f.send());assert.deepEqual(f.pair(),before);
  }
});

test('cabinet gets its migration and sanitised spy view; foreign delegates never receive those secrets',async()=>{
  const f=fixture();
  f.pair().world.strategy.spycraft.spies=[{id:'secret',owner:'Russia',target:'Germany',deployedAt:'2016-12-08',status:'active',turnedAt:'',exposedAt:'',coverStory:'',suspected:false}];
  f.answer({reply:'Обсуждаем.',stance:'discuss',actions:[]});await f.send();
  const own=JSON.parse(f.inputs.at(-1).context);assert.ok(own.migration.own.population>0);assert.equal(own.intelligence.discovered.length,0);
  assert.equal(JSON.stringify(own.intelligence).includes('secret'),false);
  await f.send('diplomacy','France');const foreign=JSON.parse(f.inputs.at(-1).context);
  assert.equal(foreign.migration,undefined);assert.equal(foreign.intelligence,undefined);
});
