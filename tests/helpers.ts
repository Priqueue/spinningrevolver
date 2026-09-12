/**
 * 测试辅助工具。
 * 允许在测试中直接改造 GameState（服务端权威状态），以便精确构造规则场景。
 */
import {
  applyFlip,
  applySwap,
  cloneState,
  createGame,
  getStateForPlayer,
  type CardValue,
  type GameState,
  type Result,
  type Seat,
  type Slot,
} from '@zuolun/shared';

/** 确定性线性同余随机源，返回 [0,1) */
export function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export interface MakeGameOpts {
  mode?: 'normal' | 'extreme';
  first?: Seat;
  seed?: number;
  names?: [string, string];
}

export function makeGame(opts: MakeGameOpts = {}): GameState {
  return createGame({
    mode: opts.mode ?? 'normal',
    names: opts.names ?? ['A', 'B'],
    initialFirst: opts.first ?? 0,
    rng: seededRng(opts.seed ?? 12345),
  });
}

/**
 * 用紧凑字符串设置某方牌堆。
 *   'd' = 暗牌，'u' = 明牌
 * 值来自 values（默认 [1,2,4,8]），按位置对应。
 */
export function setBoard(g: GameState, seat: Seat, layout: string, values: CardValue[] = [1, 2, 4, 8]): GameState {
  if (layout.length !== 4) throw new Error('layout must be 4 chars');
  g.players[seat].board = layout.split('').map((ch, i) => ({
    id: `${seat === 0 ? 'A' : 'B'}${i + 1}`,
    value: values[i],
    faceUp: ch === 'u' || ch === 'U',
  }));
  return g;
}

/** 读回某方牌堆的明暗布局，用于断言 */
export function boardLayout(g: GameState, seat: Seat): string {
  return g.players[seat].board.map((c) => (c.faceUp ? 'u' : 'd')).join('');
}

/** 读回某方牌堆的点数排列 */
export function boardValues(g: GameState, seat: Seat): CardValue[] {
  return g.players[seat].board.map((c) => c.value);
}

/** 断言成功并返回新状态 */
export function expectOk(r: Result): GameState {
  if (!r.ok) throw new Error(`expected ok but got error: ${r.code}`);
  return r.state;
}

/** 断言失败并返回错误码 */
export function expectFail(r: Result): string {
  if (r.ok) throw new Error('expected failure but got ok');
  return r.code;
}

/** 让双方都完成翻转（固定选 1 号牌位，恒定合法） */
export function doBothFlips(g: GameState): GameState {
  const r1 = applyFlip(g, g.turn, 1);
  if (!r1.ok) throw new Error(`flip 1 failed: ${r1.code}`);
  const r2 = applyFlip(r1.state, r1.state.turn, 1);
  if (!r2.ok) throw new Error(`flip 2 failed: ${r2.code}`);
  return r2.state;
}

/** 让双方都完成易位（自动挑选同状态牌对），进入下注阶段 */
export function doBothSwaps(g: GameState): { state: GameState; failed: string | null } {
  let s = cloneState(g);
  for (let step = 0; step < 2; step++) {
    const seat = s.turn;
    const board = s.players[seat].board;
    let pair: [Slot, Slot] | null = null;
    for (let i = 1 as Slot; i <= 4 && !pair; i++) {
      for (let j = (i + 1) as Slot; j <= 4; j++) {
        if (board[i - 1].faceUp === board[j - 1].faceUp) {
          pair = [i, j];
          break;
        }
      }
    }
    if (!pair) return { state: s, failed: `seat ${seat} 无可易位的同状态牌对` };
    const r = applySwap(s, seat, pair[0], pair[1]);
    if (!r.ok) return { state: s, failed: r.code };
    s = r.state;
  }
  return { state: s, failed: null };
}

/** 取某座位的个性化视图 */
export function viewOf(g: GameState, seat: Seat) {
  return getStateForPlayer(g, seat);
}

/** 递归收集对象中出现的所有键名 */
export function collectKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) {
    for (const item of v) collectKeys(item, out);
    return out;
  }
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out.add(k);
      collectKeys(val, out);
    }
  }
  return out;
}
