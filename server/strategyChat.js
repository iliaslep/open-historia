import { storyMemory } from './simulation/story.js';
import { intelligenceView } from './simulation/intelligence.js';
import { ClockRequestError } from './simulation/clockCommand.js';
import { recoverFreeformIntent, nativeThreads, conversationId, validateConversation, validateConversationReply, validateNativeChats } from './simulation/conversations.js';
import { readWorldSimulation } from './simulation/state.js';

export function createStrategyChat({ readGame, commit, ask }) {
  return async (body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(k => !['gameId', 'channel', 'target', 'model', 'prompt', 'expectedRevision'].includes(k))
      || typeof body.gameId !== 'string' || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 3000
      || typeof body.model !== 'string' || !body.model || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
      throw new ClockRequestError('Некорректное сообщение чата.');
    }
    const { gameId, model, prompt, expectedRevision } = body;
    const details = readGame(gameId);
    const data = details.data;
    const clock = readWorldSimulation(data.world);
    if (data.game.simulationMode !== 'native' || clock?.rulesVersion !== 2) throw new ClockRequestError('Выберите расчётную партию.');
    if (clock.revision !== expectedRevision) throw new ClockRequestError('Партия изменилась. Обновите чат перед отправкой.', 409);
    const state = data.world.strategy;
    const { channel, target } = validateConversation(body.channel, body.target, state);
    const chats = validateNativeChats(data.chat || [], state, data.game.gameDate);
    const thread = nativeThreads(chats).find(t => t.id === conversationId(channel, target));
    const history = (thread?.messages || []).slice(-10).map(m => ({ role: m.role, text: m.content.slice(0, 900),
      result: m.proposal?.status === 'applied' ? m.proposal.receipts : m.proposal ? 'Предложение ещё не исполнено.' : undefined }));
    const bilateral = target ? { relation: state.countries[state.player].relations[target] || 0,
      war: state.wars.some(w => [w.a, w.b].includes(target) && [w.a, w.b].includes(state.player)),
      treaties: state.treaties.filter(t => [t.a, t.b].includes(target) && [t.a, t.b].includes(state.player)) } : undefined;
    // A foreign delegation gets its own conversation and bilateral public facts,
    // never the cabinet's plans, private reports, treasury or exact readiness.
    const { relations: _privateRelations, ...ownCountry } = state.countries[state.player];
    const payload = { channel, player: state.player, target, date: data.game.gameDate, dataKind: state.dataKind, history, bilateral, alternativeHistory: storyMemory(state,channel==='diplomacy'),
      ...(channel === 'decisions' ? { ownCountry, migration: state.migration ? { own: state.migration.countries[state.player], flows: state.migration.flows.filter(f=>f.from===state.player||f.to===state.player).slice(-10) } : null, intelligence: intelligenceView(state), countries: Object.keys(state.countries).sort().slice(0, 200),
        projects: state.projects.filter(p => p.owner === state.player), reports: state.reports.slice(-3),
        treaties: state.treaties.filter(t => [t.a, t.b].includes(state.player)).slice(-12) } : {}) };
    let context=JSON.stringify(payload);
    while(context.length>20000 && history.length) {history.shift();context=JSON.stringify(payload);}
    while(context.length>20000 && payload.alternativeHistory.facts.length) {payload.alternativeHistory.facts.shift();context=JSON.stringify(payload);}
    if (context.length > 20000) throw new ClockRequestError('Контекст беседы слишком велик.');
    const completion = await ask({ model, prompt, context, purpose: 'strategy' });
    let parsed;
    try {
      const text = completion.text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, '$1');
      parsed = JSON.parse(text);
    } catch { throw new ClockRequestError('ИИ вернул ответ без проверяемого предложения. Мир не изменён; уточните сообщение.'); }
    const response = recoverFreeformIntent(validateConversationReply(parsed, channel, target, state),prompt,channel);
    // No awaits between the final revision check and journal/IDB commit. A turn
    // completed while inference was running wins; a stale response cannot apply.
    return { ...commit(gameId, { expectedRevision, channel, target, prompt, response }, 'chat-record'), usage: completion.usage };
  };
}
