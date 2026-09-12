/**
 * 个性化视图投影 —— 隐藏信息保护的唯一出口。
 *
 * 纪律（硬性）：
 *  1. 绝不把 GameState 直接序列化后删字段；一律**显式白名单构造**新对象。
 *  2. flip / swap 阶段：不包含任何牌数据（连牌背都不发）。
 *  3. bet 阶段：只包含**自己的**牌；暗牌**不写入 value 键**（而非写 null）。
 *  4. 对手的牌永远只有牌位号，不含 value / faceUp / id。
 *  5. settle / gameOver 阶段：不含任何牌数据。
 */
import { PUBLIC_SWAP_ACTION } from './constants';
import type {
  GameState,
  GameView,
  PlayerView,
  Seat,
  SelfCardView,
  Slot,
} from './types';

/** 牌数据允许下发的阶段：仅下注阶段（结算与结束阶段不自动公开牌面） */
const PHASES_WITH_OWN_CARDS = new Set(['bet']);
/** 明牌总数允许下发的阶段 */
const PHASES_WITH_FACEUP_TOTAL = new Set(['bet', 'settle', 'gameOver']);

function playerBetView(state: GameState, seat: Seat): PlayerView {
  return {
    seat,
    name: state.players[seat].name,
    chips: state.players[seat].chips,
    connected: state.players[seat].connected,
    ready: state.players[seat].ready,
    bet: state.bet.bets[seat],
    betLimit: state.bet.limitBase[seat],
    betRemaining: Math.max(0, state.bet.limitBase[seat] - state.bet.bets[seat]),
  };
}

function selfCards(state: GameState, seat: Seat): SelfCardView[] | undefined {
  if (!PHASES_WITH_OWN_CARDS.has(state.phase)) return undefined;
  const board = state.players[seat].board;
  const out: SelfCardView[] = [];
  for (let i = 0; i < 4; i++) {
    const slot = (i + 1) as Slot;
    const card = board[i];
    if (card.faceUp) {
      out.push({ slot, faceUp: true, value: card.value });
    } else {
      // 暗牌：只给出「有牌且朝下」，不含 value
      out.push({ slot, faceUp: false });
    }
  }
  return out;
}

function faceUpTotal(state: GameState): number | null {
  if (!PHASES_WITH_FACEUP_TOTAL.has(state.phase)) return null;
  let n = 0;
  for (const p of state.players) for (const c of p.board) if (c.faceUp) n += 1;
  return n;
}

export function getStateForPlayer(state: GameState, seat: Seat): GameView {
  const you = playerBetView(state, seat);
  const foe = playerBetView(state, seat === 0 ? 1 : 0);

  const yours = selfCards(state, seat);
  if (yours) you.cards = yours;

  return {
    mode: state.mode,
    round: state.round,
    first: state.first,
    second: state.second,
    phase: state.phase,
    turn: state.turn,
    status: state.status,
    you,
    opponent: foe,
    flip: { acted: [...state.flip.acted] as [boolean, boolean] },
    swap: {
      acted: [...state.swap.acted] as [boolean, boolean],
      attempts: state.swap.attempts.map((a) => ({
        player: a.player,
        // 未开启公开时连牌号都不下发，只保留「有一次尝试且合法/非法」的事实
        slots: PUBLIC_SWAP_ACTION ? ([...a.slots] as [Slot, Slot]) : null,
        valid: a.valid,
        round: a.round,
      })),
    },
    bet: {
      ante: state.bet.ante,
      bets: [...state.bet.bets] as [number, number],
      pot: state.bet.pot,
      firstStopped: state.bet.firstStopped,
      finished: state.bet.finished,
      stopped: [...state.bet.stopped] as [boolean, boolean],
      faceUpTotal: faceUpTotal(state),
    },
    settlementResult: state.settlementResult
      ? {
          ...state.settlementResult,
          scores: [...state.settlementResult.scores] as [number, number],
          chipsAfter: [...state.settlementResult.chipsAfter] as [number, number],
        }
      : undefined,
    gameOver: state.gameOver
      ? { ...state.gameOver, chips: [...state.gameOver.chips] as [number, number] }
      : undefined,
  };
}
