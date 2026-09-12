/**
 * 游戏常量 —— 如需调整规则口径，优先改这里。
 */
import type { CardValue, Mode, Slot, Seat } from './types';

/** 结算取模基数 */
export const MOD = 5;

/** 每次跟注固定筹码数 */
export const CALL_AMOUNT = 2;

/** 各模式初始筹码 */
export const CHIPS_BY_MODE: Record<Mode, number> = {
  normal: 64,
  extreme: 16,
};

/** 一副牌（每人一份） */
export const DECK_VALUES: readonly CardValue[] = [1, 2, 4, 8];

/** 牌位编号 */
export const SLOTS: readonly Slot[] = [1, 2, 3, 4];

/** 断线保留时长：10 分钟 */
export const RECONNECT_TTL_MS = 10 * 60 * 1000;

/**
 * 是否公开「对手易位的两个牌号」与非法易位记录。
 * 原始规则默认为 true；设为 false 则连牌号也不下发，只保留「已易位/非法」事实。
 */
export const PUBLIC_SWAP_ACTION = true;

/** 单次易位的非法重试上限（防止客户端异常导致无限重试） */
export const MAX_SWAP_ATTEMPTS_PER_ROUND = 20;

/** 结算主循环防御上限 */
export const SETTLE_GUARD = 200;

/** 破平循环防御上限（数学上 ≤5 步必终止） */
export const TIEBREAK_GUARD = 10;

/** 房间号长度与字符集（去掉易混淆字符） */
export const ROOM_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_ID_LENGTH = 4;

/** 玩家令牌字节数（32 字节 → 256 bit 熵） */
export const PLAYER_TOKEN_BYTES = 32;

/** 房间空置清理间隔 */
export const ROOM_SWEEP_INTERVAL_MS = 30 * 1000;

/** 每轮先手推算：first = (initialFirst + round - 1) % 2 */
export function firstOf(initialFirst: Seat, round: number): Seat {
  return ((initialFirst + round - 1) % 2) as Seat;
}

/** 另一座位 */
export function other(seat: Seat): Seat {
  return (1 - seat) as Seat;
}

/** 向上取整的整数除法（禁止使用浮点 Math.ceil(a/b)） */
export function ceilDiv(a: number, b: number): number {
  if (b <= 0) throw new Error('ceilDiv: b must be > 0');
  if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error('ceilDiv: integers required');
  return Math.floor((a + b - 1) / b);
}

/** 座位断言 */
export function isSeat(v: unknown): v is Seat {
  return v === 0 || v === 1;
}

/** 牌位断言 */
export function isSlot(v: unknown): v is Slot {
  return v === 1 || v === 2 || v === 3 || v === 4;
}

/** 模式断言 */
export function isMode(v: unknown): v is Mode {
  return v === 'normal' || v === 'extreme';
}
