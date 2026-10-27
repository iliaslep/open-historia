import { ClockRequestError } from './simulation/clockCommand.js';
import { advanceSimulationClock } from './simulation/time.js';
import { readWorldSimulation } from './simulation/state.js';
import { applyNewspaper, newspaperContext } from './simulation/newspaper.js';

export function createStrategyAdvance({readGame,commit,ask}) {
  return async body=>{
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['gameId','model','step','expectedRevision'].includes(k))
      ||typeof body.gameId!=='string'||typeof body.model!=='string'||!body.model||!['day','week','month'].includes(body.step)
      ||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)throw new ClockRequestError('Некорректный ИИ-ход.');
    const {gameId,model,step,expectedRevision}=body;
    const data=readGame(gameId).data,clock=readWorldSimulation(data.world);
    if(data.game.simulationMode!=='native'||clock?.rulesVersion!==2)throw new ClockRequestError('Выберите расчётную партию.');
    if(clock.revision!==expectedRevision)throw new ClockRequestError('Партия изменилась перед перемоткой.',409);
    // Preview only: failure, cancellation or another winning command leaves
    // dates/resources untouched. The commit replays and checks the same result.
    const next=advanceSimulationClock({game:data.game,world:data.world},step);
    const context=JSON.stringify(newspaperContext(next.world.strategy,clock.date,next.game.gameDate));
    if(context.length>65000)throw new ClockRequestError('Газетный контекст слишком велик. Выберите меньший шаг.');
    const completion=await ask({model,purpose:'simulation',prompt:'Симулируй мировые события за этот ход и подготовь газетный выпуск.',context});
    let response;
    try {response=JSON.parse(completion.text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/,'$1'));}
    catch {throw new ClockRequestError('ИИ не завершил газетный выпуск. Время не изменено; можно повторить или выполнить ход без ИИ.');}
    applyNewspaper(next.world.strategy,response,clock.date,next.game.gameDate);
    return {...commit(gameId,{expectedRevision,step,response},'news-advance'),usage:completion.usage};
  };
}
