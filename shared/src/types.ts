/**
 * 翻转左轮 —— 共享类型定义
 *
 * 设计纪律：
 *  - 本文件所有类型均为可结构化克隆的纯数据（无类实例、无函数、无循环引用）。
 *  - GameState 是服务端权威完整状态；任何下发客户端的对象都必须经 view.ts 白名单投影。
 */

/** 牌面值：A=1, 2=2, 4=4, 8=8 */
export type CardValue = 1 | 2 | 4 | 8;

/** 座位：0 = A，1 = B */
export type Seat = 0 | 1;

/** 牌位编号 1..4 */
export type Slot = 1 | 2 | 3 | 4;

/** 游戏模式：正常=每人 64 筹码；极限=每人 16 筹码 */
export type Mode = 'normal' | 'extreme';

/** 对局阶段 */
export type Phase = 'flip' | 'swap' | 'bet' | 'settle' | 'gameOver';

/** 房间/对局状态 */
export type GameStatus = 'playing' | 'paused' | 'gameOver';

/** 游戏结束原因 */
export type GameOverReason =
  | 'insolventAnte' // 底注不足
  | 'insolventPayment' // 赔付时败方筹码不足
  | 'rematch'; // 保留位（当前未使用）

/** 一张牌（服务端机密） */
export interface Card {
  /** 稳定标识，仅服务端使用，绝不下发 */
  id: string;
  value: CardValue;
  /** true = 明牌（牌面朝上），false = 暗牌 */
  faceUp: boolean;
}

/** 一名玩家的完整状态（服务端机密） */
export interface PlayerState {
  seat: Seat;
  name: string;
  chips: number;
  /** 长度恒为 4；下标 0..3 对应牌位 1..4 */
  board: Card[];
  connected: boolean;
  socketId?: string;
  /** 断线时刻（ms epoch），仅用于离线清理 */
  disconnectedAt?: number;
  /** 是否已准备（等待房间用） */
  ready: boolean;
}

/** 易位尝试记录（公开：只含牌号与合法性，不含明暗状态） */
export interface SwapAttempt {
  player: Seat;
  slots: [Slot, Slot];
  valid: boolean;
  round: number;
}

/** 一次结算的完整结果（公开） */
export interface SettlementResult {
  /** 结算结束时的累加器值 */
  S: number;
  /** 双方得分 [A, B] */
  scores: [number, number];
  /** 是否触发了破平（k:k 平局） */
  tieBreak: boolean;
  /** 破平起始方（未触发破平时为 null） */
  tieBreakStarter: Seat | null;
  /** 最后一张被计入的明牌的所有者（无明牌为 null） */
  lastBrightOwner: Seat | null;
  /** 本轮场上总筹码 N */
  pot: number;
  /** 高分者（按规则告负） */
  loser: Seat;
  /** 低分者（按规则获胜） */
  winner: Seat;
  /** 计算用的 a（= 败方得分） */
  a: number;
  /** 计算用的 b（= 胜方得分；若为 0 则已补为 1） */
  b: number;
  /** 败方应付 */
  payment: number;
  /** 胜方被扣除 */
  deduction: number;
  /** 胜方实收 = payment - deduction */
  winnerReceive: number;
  /** 败方实际支付（筹码不足时小于 payment） */
  actualPaid: number;
  /** 赔付后双方筹码 */
  chipsAfter: [number, number];
}

/** 游戏结束信息 */
export interface GameOverInfo {
  winner: Seat;
  reason: GameOverReason;
  /** 结束时的双方筹码 */
  chips: [number, number];
}

/** 完整对局状态（服务端权威） */
export interface GameState {
  mode: Mode;
  /** 首轮先手（开局随机决定，之后固定用于推算每轮先手） */
  initialFirst: Seat;
  /** 当前轮先手 = (initialFirst + round - 1) % 2 */
  first: Seat;
  /** 当前轮后手 */
  second: Seat;
  /** 轮次，从 1 开始 */
  round: number;
  phase: Phase;
  /** 当前行动者 */
  turn: Seat;
  status: GameStatus;
  players: [PlayerState, PlayerState];

  flip: {
    acted: [boolean, boolean];
  };

  swap: {
    acted: [boolean, boolean];
    attempts: SwapAttempt[];
  };

  bet: {
    /** 本把底注（双方相同） */
    ante: number;
    /** 本轮各自累计投入（含底注） */
    bets: [number, number];
    /** = bets[0] + bets[1] */
    pot: number;
    /** 下注开始时的筹码快照（底注扣除之后），仅用于展示 */
    callBase: [number, number];
    /** 本轮冻结的总注上限：limitBase[i] = floor(callBase[1-i] / 2) */
    limitBase: [number, number];
    /** 先手是否已停注 */
    firstStopped: boolean;
    /** 本轮下注是否结束 */
    finished: boolean;
    /** 已停注的座位（用于幂等判定） */
    stopped: [boolean, boolean];
  };

  settlementResult?: SettlementResult;
  gameOver?: GameOverInfo;
}

/** ---------- 动作载荷 ---------- */

export type FlipAction = { type: 'flip'; slot: Slot };
export type SwapAction = { type: 'swap'; slots: [Slot, Slot] };
export type BetActionPayload =
  | { type: 'bet'; action: 'call' }
  | { type: 'bet'; action: 'raise'; amount: number }
  | { type: 'bet'; action: 'stop' };

export type GameAction = FlipAction | SwapAction | BetActionPayload;

/** ---------- 结果类型 ---------- */

export type ErrorCode =
  | 'BAD_MODE'
  | 'BAD_SLOT'
  | 'BAD_SLOTS'
  | 'NOT_PLAYING'
  | 'NOT_YOUR_TURN'
  | 'ALREADY_ACTED'
  | 'WRONG_PHASE'
  | 'SWAP_STATE_MISMATCH'
  | 'BET_BAD_AMOUNT'
  | 'BET_INSUFFICIENT_CHIPS'
  | 'BET_OVER_LIMIT'
  | 'ALREADY_STOPPED'
  | 'BAD_ACTION';

/** 供房间层落日志的结构化提示（不含任何机密信息） */
export type LogHint =
  | { kind: 'flipDone'; actor: Seat }
  | { kind: 'swapApplied'; actor: Seat; slots: [Slot, Slot] }
  | { kind: 'swapRejected'; actor: Seat; slots: [Slot, Slot]; code: ErrorCode }
  | { kind: 'ante'; ante: number; faceUpTotal: number }
  | { kind: 'call'; actor: Seat; amount: number; pot: number }
  | { kind: 'raise'; actor: Seat; amount: number; pot: number }
  | { kind: 'stop'; actor: Seat }
  | { kind: 'betEnd'; pot: number }
  | { kind: 'settled'; result: SettlementResult }
  | { kind: 'gameOver'; info: GameOverInfo };

export type Result =
  | { ok: true; state: GameState; logHints: LogHint[] }
  | { ok: false; code: ErrorCode };

/** ---------- 个性化视图（下发客户端，经白名单构造） ---------- */

/**
 * 自己的牌。
 *  - phase === 'bet' 且 faceUp === true 时才有 value 字段（暗牌**不存在** value 键）
 *  - 翻转/易位阶段不下发任何牌对象
 */
export type SelfCardView =
  | { slot: Slot; faceUp: true; value: CardValue }
  | { slot: Slot; faceUp: false };

/** 对手的牌：永远只有牌位号，没有任何明暗或点数信息 */
export interface OpponentCardView {
  slot: Slot;
}

export interface PlayerView {
  seat: Seat;
  name: string;
  chips: number;
  connected: boolean;
  ready: boolean;
  /** 仅在 bet 阶段存在；其余阶段为 undefined */
  cards?: SelfCardView[];
  /** 本轮累计投入（含底注） */
  bet: number;
  /** 本轮剩余可投注额度（上限 - 已投注） */
  betRemaining: number;
  /** 本轮总注上限（冻结值） */
  betLimit: number;
}

export interface GameView {
  mode: Mode;
  round: number;
  first: Seat;
  second: Seat;
  phase: Phase;
  turn: Seat;
  status: GameStatus;
  you: PlayerView;
  opponent: PlayerView;
  flip: { acted: [boolean, boolean] };
  swap: {
    acted: [boolean, boolean];
    /** 按 PUBLIC_SWAP_ACTION 决定是否下发牌号；未公开时 slots 为 null */
    attempts: { player: Seat; slots: [Slot, Slot] | null; valid: boolean; round: number }[];
  };
  bet: {
    ante: number;
    bets: [number, number];
    pot: number;
    firstStopped: boolean;
    finished: boolean;
    stopped: [boolean, boolean];
    /** 仅在 bet 阶段下发；其余阶段为 null */
    faceUpTotal: number | null;
  };
  settlementResult?: SettlementResult;
  gameOver?: GameOverInfo;
}
