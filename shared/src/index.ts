/**
 * 翻转左轮共享包入口。
 * 仅 re-export 稳定 API；内部工具函数不进公共出口。
 */
export * from './types';
export * from './constants';
export * from './protocol';
export {
  createGame,
  startRound,
  applyFlip,
  applySwap,
  applyBet,
  applyStop,
  applyAction,
  beginBetPhase,
  calculateAnte,
  countFaceUp,
  settleRound,
  advanceRound,
  rematch,
  shuffleDeck,
  cloneState,
} from './rules';
export type { CreateGameOptions, SettleOutcome } from './rules';
export { getStateForPlayer } from './view';
