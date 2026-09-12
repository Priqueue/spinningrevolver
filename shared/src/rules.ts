/**
 * 翻转左轮 —— 纯规则引擎（零依赖、无 IO、无隐式随机）
 *
 * 设计契约：
 *  1. 所有对外函数都是纯函数：接收 GameState，返回新的 GameState，绝不修改入参。
 *  2. 失败路径返回 { ok:false, code }，且不产生任何状态变更（返回的 state 与入参引用语义等价）。
 *  3. GameState 含机密信息，绝不可直接下发客户端；下发必须经 view.ts 的白名单投影。
 *
 * 结算算法采用「各自维护牌位指针」的双指针模型，详见 docs/rules-spec.md §4.5.1。
 */
import {
  CALL_AMOUNT,
  CHIPS_BY_MODE,
  DECK_VALUES,
  MOD,
  SETTLE_GUARD,
  TIEBREAK_GUARD,
  ceilDiv,
  firstOf,
  isMode,
  isSeat,
  isSlot,
  other,
} from './constants';
import type {
  BetActionPayload,
  Card,
  CardValue,
  ErrorCode,
  GameOverReason,
  GameState,
  LogHint,
  Result,
  Seat,
  SettlementResult,
  Slot,
  SwapAttempt,
} from './types';

/** ---------- 基础工具 ---------- */

export function cloneState(s: GameState): GameState {
  return {
    ...s,
    players: [
      { ...s.players[0], board: s.players[0].board.map((c) => ({ ...c })) },
      { ...s.players[1], board: s.players[1].board.map((c) => ({ ...c })) },
    ],
    flip: { acted: [...s.flip.acted] as [boolean, boolean] },
    swap: {
      acted: [...s.swap.acted] as [boolean, boolean],
      attempts: s.swap.attempts.map((a) => ({ ...a, slots: [...a.slots] as [Slot, Slot] })),
    },
    bet: { ...s.bet, bets: [...s.bet.bets] as [number, number], callBase: [...s.bet.callBase] as [number, number], limitBase: [...s.bet.limitBase] as [number, number], stopped: [...s.bet.stopped] as [boolean, boolean] },
    settlementResult: s.settlementResult
      ? { ...s.settlementResult, scores: [...s.settlementResult.scores] as [number, number], chipsAfter: [...s.settlementResult.chipsAfter] as [number, number] }
      : undefined,
    gameOver: s.gameOver ? { ...s.gameOver, chips: [...s.gameOver.chips] as [number, number] } : undefined,
  };
}

const ok = (state: GameState, logHints: LogHint[] = []): Result => ({ ok: true, state, logHints });
const fail = (code: ErrorCode): Result => ({ ok: false, code });

/** ---------- 洗牌与建局 ---------- */

/** Fisher-Yates 洗牌；rng 必须返回 [0,1) */
export function shuffleDeck(rng: () => number, values: readonly CardValue[] = DECK_VALUES): CardValue[] {
  const out = values.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const r = Math.min(0.9999999, Math.max(0, rng()));
    const j = Math.floor(r * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

export interface CreateGameOptions {
  mode: string;
  names?: [string, string];
  /** 指定首轮先手；不传则用 rng 随机决定 */
  initialFirst?: Seat;
  /** 随机源，默认 Math.random；测试可注入 */
  rng?: () => number;
}

export function createGame(opts: CreateGameOptions): GameState {
  if (!isMode(opts.mode)) throw new Error('BAD_MODE');
  const mode = opts.mode;
  const rng = opts.rng ?? Math.random;
  const names = opts.names ?? ['玩家A', '玩家B'];
  const initialFirst: Seat = isSeat(opts.initialFirst)
    ? opts.initialFirst
    : (Math.floor(Math.min(0.9999999, Math.max(0, rng())) * 2) as Seat);
  const chips = CHIPS_BY_MODE[mode];
  const round = 1;
  const first = firstOf(initialFirst, round);
  // 洗牌顺序固定，保证注入 rng 时结果完全确定
  const boardA = shuffleDeck(rng).map((value, i) => ({ id: `A${i + 1}`, value, faceUp: false }));
  const boardB = shuffleDeck(rng).map((value, i) => ({ id: `B${i + 1}`, value, faceUp: false }));
  return {
    mode,
    initialFirst,
    first,
    second: other(first),
    round,
    phase: 'flip',
    turn: first,
    status: 'playing',
    players: [
      {
        seat: 0,
        name: names[0],
        chips,
        board: boardA,
        connected: true,
        ready: true,
      },
      {
        seat: 1,
        name: names[1],
        chips,
        board: boardB,
        connected: true,
        ready: true,
      },
    ],
    flip: { acted: [false, false] },
    swap: { acted: [false, false], attempts: [] },
    bet: {
      ante: 0,
      bets: [0, 0],
      pot: 0,
      callBase: [chips, chips],
      limitBase: [0, 0],
      firstStopped: false,
      finished: false,
      stopped: [false, false],
    },
  };
}

/** ---------- 阶段流转 ---------- */

/** 进入新的一轮：轮次 +1、交换先后手、清空本轮临时状态；牌与筹码保留 */
export function startRound(state: GameState): GameState {
  const s = cloneState(state);
  s.round += 1;
  s.first = firstOf(s.initialFirst, s.round);
  s.second = other(s.first);
  s.turn = s.first;
  s.phase = 'flip';
  s.flip = { acted: [false, false] };
  s.swap = { acted: [false, false], attempts: s.swap.attempts };
  s.bet = {
    ante: 0,
    bets: [0, 0],
    pot: 0,
    callBase: [s.players[0].chips, s.players[1].chips],
    limitBase: [0, 0],
    firstStopped: false,
    finished: false,
    stopped: [false, false],
  };
  // 上一轮的结算结果保留在新一轮中展示（下一轮结算时自然被覆盖）
  return s;
}

/** ---------- 阶段 FLIP ---------- */

export function applyFlip(state: GameState, actor: Seat, slot: Slot): Result {
  if (!state || state.status !== 'playing') return fail('NOT_PLAYING');
  if (state.phase !== 'flip') return fail('WRONG_PHASE');
  if (!isSeat(actor)) return fail('NOT_YOUR_TURN');
  if (actor !== state.turn) return fail('NOT_YOUR_TURN');
  if (state.flip.acted[actor]) return fail('ALREADY_ACTED');
  if (!isSlot(slot)) return fail('BAD_SLOT');

  const s = cloneState(state);
  const me = s.players[actor];
  const foe = s.players[other(actor)];
  const i = slot - 1;
  const mine = me.board[i];
  const theirs = foe.board[i];

  if (mine.faceUp === theirs.faceUp) {
    // 状态相同：翻转自己的 n 号牌
    mine.faceUp = !mine.faceUp;
  } else {
    // 状态不同：交换双方的 n 号牌（牌对象整体互换，牌位仍为 n）
    me.board[i] = theirs;
    foe.board[i] = mine;
  }

  s.flip.acted[actor] = true;
  if (s.flip.acted[0] && s.flip.acted[1]) {
    s.phase = 'swap';
    s.turn = s.first;
  } else {
    s.turn = other(actor);
  }
  // 日志不含牌号，也不含任何牌信息
  return ok(s, [{ kind: 'flipDone', actor }]);
}

/** ---------- 阶段 SWAP ---------- */

export function applySwap(state: GameState, actor: Seat, slotA: Slot, slotB: Slot): Result {
  if (!state || state.status !== 'playing') return fail('NOT_PLAYING');
  if (state.phase !== 'swap') return fail('WRONG_PHASE');
  if (!isSeat(actor)) return fail('NOT_YOUR_TURN');
  if (actor !== state.turn) return fail('NOT_YOUR_TURN');
  if (state.swap.acted[actor]) return fail('ALREADY_ACTED');

  const record = (s: GameState, valid: boolean): void => {
    s.swap.attempts.push({ player: actor, slots: [slotA, slotB], valid, round: s.round });
  };

  if (!isSlot(slotA) || !isSlot(slotB) || slotA === slotB) {
    // 非法选择：记录但不改变任何牌局状态
    const s = cloneState(state);
    record(s, false);
    return ok(s, [{ kind: 'swapRejected', actor, slots: [slotA, slotB], code: 'BAD_SLOTS' }]);
  }

  const me = state.players[actor];
  const a = me.board[slotA - 1];
  const b = me.board[slotB - 1];

  if (a.faceUp !== b.faceUp) {
    // 非法易位：状态零变更，要求重选。公开记录只含牌号与非法事实，绝不含明暗状态。
    const s = cloneState(state);
    record(s, false);
    return ok(s, [{ kind: 'swapRejected', actor, slots: [slotA, slotB], code: 'SWAP_STATE_MISMATCH' }]);
  }

  const s = cloneState(state);
  const board = s.players[actor].board;
  board[slotA - 1] = b;
  board[slotB - 1] = a;
  s.swap.acted[actor] = true;
  record(s, true);

  const hints: LogHint[] = [{ kind: 'swapApplied', actor, slots: [slotA, slotB] }];

  if (s.swap.acted[0] && s.swap.acted[1]) {
    const anteRes = beginBetPhase(s);
    if (!anteRes.ok) return anteRes;
    return ok(anteRes.state, [...hints, ...anteRes.logHints]);
  }
  s.turn = other(actor);
  return ok(s, hints);
}

/** ---------- 底注与下注阶段入口 ---------- */

/** 当前明牌总数（服务端内部） */
export function countFaceUp(state: GameState): number {
  let n = 0;
  for (const p of state.players) for (const c of p.board) if (c.faceUp) n += 1;
  return n;
}

/** 底注 = ceil(双方明牌总数 / 2) */
export function calculateAnte(state: GameState): number {
  return ceilDiv(countFaceUp(state), 2);
}

/**
 * 底注偿付检查 + 下注阶段初始化。
 * 顺序固定：先手先检查。因此双方都付不出时判先手负（后手获胜）。
 */
export function beginBetPhase(state: GameState): Result {
  const s = cloneState(state);
  const ante = calculateAnte(s);
  const first = s.first;
  const second = s.second;

  if (s.players[first].chips < ante) {
    // 先手无力支付底注 → 先手负
    return ok(endGame(s, second, 'insolventAnte'), [
      { kind: 'ante', ante, faceUpTotal: countFaceUp(s) },
    ]);
  }
  if (s.players[second].chips < ante) {
    // 先手能付、后手不能 → 后手负
    return ok(endGame(s, first, 'insolventAnte'), [
      { kind: 'ante', ante, faceUpTotal: countFaceUp(s) },
    ]);
  }

  s.players[0].chips -= ante;
  s.players[1].chips -= ante;
  s.bet.ante = ante;
  s.bet.bets = [ante, ante];
  s.bet.pot = ante * 2;
  // 下注开始时的筹码快照（底注扣除之后）
  s.bet.callBase = [s.players[0].chips, s.players[1].chips];
  // 上限基数：floor(对手在下注开始时的筹码 / 2)，本轮冻结不变
  s.bet.limitBase = [Math.floor(s.bet.callBase[1] / 2), Math.floor(s.bet.callBase[0] / 2)];
  s.bet.firstStopped = false;
  s.bet.finished = false;
  s.bet.stopped = [false, false];
  s.phase = 'bet';
  s.turn = first;

  return ok(s, [
    { kind: 'ante', ante, faceUpTotal: countFaceUp(s) },
  ]);
}

/** ---------- 阶段 BET ---------- */

/**
 * 下注动作入口。
 * 若本次动作满足结束条件（后手已行动过且先手已停注 / 后手停注），**立即结算**。
 */
export function applyBet(state: GameState, actor: Seat, action: BetActionPayload): Result {
  if (action.type !== 'bet') return fail('BAD_ACTION');
  if (action.action === 'stop') return applyStop(state, actor);
  const res = applyBetAction(state, actor, action);
  if (!res.ok) return res;
  return finishBetIfDone(res.state, res.logHints);
}

/** 停注入口；后手停注时立即结算 */
export function applyStop(state: GameState, actor: Seat): Result {
  const res = applyStopAction(state, actor);
  if (!res.ok) return res;
  return finishBetIfDone(res.state, res.logHints);
}

/** 内部：跟注 / 加注（不触发结算） */
function applyBetAction(
  state: GameState,
  actor: Seat,
  action: Extract<BetActionPayload, { action: 'call' | 'raise' }>,
): Result {
  if (!state || state.status !== 'playing') return fail('NOT_PLAYING');
  if (state.phase !== 'bet') return fail('WRONG_PHASE');
  if (state.bet.finished) return fail('WRONG_PHASE');
  if (!isSeat(actor)) return fail('NOT_YOUR_TURN');
  if (actor !== state.turn) return fail('NOT_YOUR_TURN');
  if (state.bet.stopped[actor]) return fail('ALREADY_STOPPED');

  const cost = action.action === 'call' ? CALL_AMOUNT : action.amount;
  if (!Number.isInteger(cost) || cost <= 0) return fail('BET_BAD_AMOUNT');

  if (state.players[actor].chips < cost) return fail('BET_INSUFFICIENT_CHIPS');
  if (state.bet.bets[actor] + cost > state.bet.limitBase[actor]) return fail('BET_OVER_LIMIT');

  const s = cloneState(state);
  s.players[actor].chips -= cost;
  s.bet.bets[actor] += cost;
  s.bet.pot += cost;

  const hints: LogHint[] = [
    action.action === 'call'
      ? { kind: 'call', actor, amount: cost, pot: s.bet.pot }
      : { kind: 'raise', actor, amount: cost, pot: s.bet.pot },
  ];

  // 先手停注后，后手做一次选择即自动停注并结算
  if (actor === s.second && s.bet.firstStopped) {
    s.bet.finished = true;
  } else {
    s.turn = other(actor);
  }
  return ok(s, hints);
}

/** 内部：停注（不触发结算） */
function applyStopAction(state: GameState, actor: Seat): Result {
  if (!state || state.status !== 'playing') return fail('NOT_PLAYING');
  if (state.phase !== 'bet') return fail('WRONG_PHASE');
  if (state.bet.finished) return fail('WRONG_PHASE');
  if (!isSeat(actor)) return fail('NOT_YOUR_TURN');
  if (actor !== state.turn) return fail('NOT_YOUR_TURN');
  if (state.bet.stopped[actor]) return fail('ALREADY_STOPPED');

  const s = cloneState(state);
  s.bet.stopped[actor] = true;
  const hints: LogHint[] = [{ kind: 'stop', actor }];

  if (actor === s.first) {
    // 先手停注 → 后手仍可做一次选择
    s.bet.firstStopped = true;
    s.turn = s.second;
  } else {
    // 后手停注 → 直接结算
    s.bet.finished = true;
  }
  return ok(s, hints);
}

/** 下注阶段结束时立即结算 */
function finishBetIfDone(state: GameState, hints: LogHint[]): Result {
  if (state.phase === 'bet' && state.bet.finished) {
    const { state: settled, logHints } = settleRound(state);
    return ok(settled, [...hints, ...logHints]);
  }
  return ok(state, hints);
}

/** ---------- 结束对局 ---------- */

function endGame(s: GameState, winner: Seat, reason: GameOverReason): GameState {
  s.phase = 'gameOver';
  s.status = 'gameOver';
  s.gameOver = {
    winner,
    reason,
    chips: [s.players[0].chips, s.players[1].chips],
  };
  return s;
}

/** ---------- 结算 ---------- */

export interface SettleOutcome {
  result: SettlementResult;
  /** 是否在赔付阶段因筹码不足而结束对局 */
  gameEnded: boolean;
}

/**
 * 结算：计算比分（含破平）→ 判定胜负 → 赔付 → 必要时结束对局。
 * 返回的 GameState 已完成赔付与筹码变更。
 */
export function settleRound(state: GameState): { state: GameState; outcome: SettleOutcome; logHints: LogHint[] } {
  const s = cloneState(state);
  const N = s.bet.pot;

  let S = 0;
  const scores: [number, number] = [0, 0];
  let lastBrightOwner: Seat | null = null;
  const completed: [boolean, boolean] = [false, false];
  const cursor: [number, number] = [1, 1];
  let holder = s.second;

  let guard = 0;
  while (guard++ < SETTLE_GUARD) {
    if (completed[holder]) {
      const o = other(holder);
      if (completed[o]) break;
      holder = o;
      continue;
    }
    const i = cursor[holder];
    const card = s.players[holder].board[i - 1];
    if (card.faceUp) {
      S = (S + card.value) % MOD;
      if (S === 0) scores[holder] += 1;
      lastBrightOwner = holder;
      cursor[holder] += 1;
      if (cursor[holder] > 4) completed[holder] = true;
      holder = other(holder);
    } else {
      cursor[holder] += 1;
      if (cursor[holder] > 4) completed[holder] = true;
    }
  }

  // 破平：对所有 k:k 平局生效
  let tieBreak = false;
  let tieBreakStarter: Seat | null = null;
  if (scores[0] === scores[1]) {
    tieBreak = true;
    let q: Seat = lastBrightOwner === null ? s.second : other(lastBrightOwner);
    tieBreakStarter = q;
    let g = 0;
    while (g++ < TIEBREAK_GUARD) {
      S = (S + 1) % MOD;
      if (S === 0) {
        scores[q] += 1;
        break;
      }
      q = other(q);
    }
  }

  if (scores[0] === scores[1]) {
    throw new Error('settleRound: 不变量被破坏 —— 破平后比分仍相等');
  }

  // 高分者输
  const loser: Seat = scores[0] > scores[1] ? 0 : 1;
  const winner: Seat = other(loser);
  const a = scores[loser];
  let b = scores[winner];
  if (b === 0) b = 1;
  const den = a + b;
  // 败方总损失：ceil(N·a / (a+b))
  const payment = ceilDiv(N * a, den);
  // 胜方被扣除：ceil(N / (a+b))，该部分筹码永久移出游戏
  const deduction = ceilDiv(N, den);

  const loserChips = s.players[loser].chips;
  const canPay = loserChips >= payment;
  const actualPaid = canPay ? payment : loserChips; // 筹码不足时支付剩余全部

  // ---- 赔付 ----
  // 严格按规则文档 §2.10 的两个公式：
  //   败方.chips -= actualPaid                 （败方按 ceil(N·a/(a+b)) 支付）
  //   胜方.chips += actualPaid - deduction     （胜方实收 = 支付 − 扣除）
  //   ⇒ Σ筹码净变化 = −deduction：被扣除的筹码永久移出游戏，总量只减不增 ✓
  //
  // 注意（重要，已在交付说明中标注）：当 a = b 时 payment 与 deduction 都等于 ceil(N/2)，
  // 于是「胜方实收」为 0 —— 胜方不赔不赚，负方净亏，筹码随扣除缓慢减少。
  // 这是规则文档公式的直接推论。若希望「胜方一定盈利」，可把本行改为
  // Math.max(0, N - actualPaid)（此时胜方收下整池，扣除改由胜方承担）。
  const winnerReceive = Math.max(0, actualPaid - deduction);
  s.players[loser].chips -= actualPaid;
  s.players[winner].chips += winnerReceive;

  const result: SettlementResult = {
    S,
    scores,
    tieBreak,
    tieBreakStarter,
    lastBrightOwner,
    pot: N,
    loser,
    winner,
    a,
    b,
    payment,
    deduction,
    winnerReceive,
    actualPaid,
    chipsAfter: [s.players[0].chips, s.players[1].chips],
  };
  s.settlementResult = result;
  s.bet.finished = true;

  const hints: LogHint[] = [{ kind: 'settled', result }];

  let gameEnded = false;
  if (!canPay) {
    // 败方筹码不足：支付剩余全部筹码，对局立即结束
    endGame(s, winner, 'insolventPayment');
    gameEnded = true;
    hints.push({ kind: 'gameOver', info: s.gameOver! });
  } else {
    s.phase = 'settle';
  }

  return { state: s, outcome: { result, gameEnded }, logHints: hints };
}

/** ---------- 便捷入口 ---------- */

/** 统一动作入口（服务端 socket 层使用）。下注结束时会自动结算。 */
export function applyAction(
  state: GameState,
  actor: Seat,
  action: BetActionPayload | { type: 'flip'; slot: Slot } | { type: 'swap'; slots: [Slot, Slot] },
): Result {
  if (action.type === 'flip') {
    if (!isSlot(action.slot)) return fail('BAD_SLOT');
    return applyFlip(state, actor, action.slot);
  }
  if (action.type === 'swap') {
    const slots = action.slots;
    if (!Array.isArray(slots) || slots.length !== 2) return fail('BAD_SLOTS');
    return applySwap(state, actor, slots[0], slots[1]);
  }
  if (action.type === 'bet') {
    return applyBet(state, actor, action);
  }
  return fail('BAD_ACTION');
}

/** 结算完成后推进到下一轮（未结束的前提下） */
export function advanceRound(state: GameState): GameState {
  if (state.phase !== 'settle' || state.status === 'gameOver') return state;
  return startRound(state);
}

/** 复原一个已结束的对局（再来一局） */
export function rematch(prev: GameState, opts: { initialFirst?: Seat; rng?: () => number } = {}): GameState {
  return createGame({
    mode: prev.mode,
    names: [prev.players[0].name, prev.players[1].name],
    initialFirst: opts.initialFirst,
    rng: opts.rng,
  });
}

export { CALL_AMOUNT, MOD, ceilDiv, firstOf, other };
