/**
 * 阶段 2 验收测试 —— 隐藏信息（个性化视图投影）
 * 对应 docs/rules-spec.md §5 与 §11.10。
 *
 * 这是安全关键测试：任何一条断言失败都意味着隐藏信息泄漏。
 */
import { describe, expect, it } from 'vitest';
import {
  applyBet,
  applyFlip,
  applyStop,
  applySwap,
  beginBetPhase,
  getStateForPlayer,
  settleRound,
  type CardValue,
  type GameState,
  type GameView,
  type Seat,
  type Slot,
} from '@zuolun/shared';
import { collectKeys, expectOk, makeGame, setBoard } from './helpers';

function hasKey(v: unknown, key: string): boolean {
  return collectKeys(v).has(key);
}

/** 递归收集导出对象中所有 "value" 键的数值 */
function collectValues(v: unknown, out: number[] = []): number[] {
  if (Array.isArray(v)) {
    for (const item of v) collectValues(item, out);
    return out;
  }
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'value' && typeof val === 'number') out.push(val);
      collectValues(val, out);
    }
  }
  return out;
}

function withBoards(
  a: string,
  b: string,
  first: Seat = 0,
  av?: CardValue[],
  bv?: CardValue[],
): GameState {
  const g = makeGame({ first });
  setBoard(g, 0, a, av);
  setBoard(g, 1, b, bv);
  return g;
}

/** 进入易位阶段（A: 1明2明3暗4暗 / B: 1暗2明3明4暗） */
function swapPhase(): GameState {
  const g = withBoards('uudd', 'uddu', 0, [1, 2, 4, 8], [8, 2, 4, 1]);
  const a = expectOk(applyFlip(g, 0, 1));
  const b = expectOk(applyFlip(a, 1, 1));
  expect(b.phase).toBe('swap');
  return b;
}

/** 进入下注阶段 */
function betPhase(a = 'uudd', b = 'uudd', av?: CardValue[], bv?: CardValue[]): GameState {
  return expectOk(beginBetPhase(withBoards(a, b, 0, av, bv)));
}

describe('11.10 翻转阶段不泄露任何牌信息', () => {
  it('视图不含 cards / value / faceUp / board / id 等任何牌字段', () => {
    const g = withBoards('dudd', 'uddu');
    for (const seat of [0, 1] as Seat[]) {
      const v = getStateForPlayer(g, seat);
      expect(v.phase).toBe('flip');
      expect(hasKey(v, 'cards')).toBe(false);
      expect(hasKey(v, 'faceUp')).toBe(false);
      expect(hasKey(v, 'value')).toBe(false);
      expect(hasKey(v, 'board')).toBe(false);
      expect(hasKey(v, 'id')).toBe(false);
      expect(v.bet.faceUpTotal).toBeNull();
    }
  });

  it('一方翻转完成后仍不泄露任何牌信息', () => {
    const g = withBoards('dudd', 'uddu');
    const s = expectOk(applyFlip(g, 0, 1));
    for (const seat of [0, 1] as Seat[]) {
      const v = getStateForPlayer(s, seat);
      expect(hasKey(v, 'cards')).toBe(false);
      expect(hasKey(v, 'faceUp')).toBe(false);
      expect(hasKey(v, 'value')).toBe(false);
    }
  });

  it('视图 JSON 中不出现任何牌面点数键', () => {
    const g = withBoards('dddd', 'dddd');
    for (const seat of [0, 1] as Seat[]) {
      const text = JSON.stringify(getStateForPlayer(g, seat));
      expect(text.includes('"value"')).toBe(false);
      expect(text.includes('"faceUp"')).toBe(false);
    }
  });
});

describe('11.10 易位阶段不泄露任何牌信息', () => {
  it('视图不含任何牌字段', () => {
    const s = swapPhase();
    for (const seat of [0, 1] as Seat[]) {
      const v = getStateForPlayer(s, seat);
      expect(v.phase).toBe('swap');
      expect(hasKey(v, 'cards')).toBe(false);
      expect(hasKey(v, 'value')).toBe(false);
      expect(hasKey(v, 'faceUp')).toBe(false);
    }
  });

  it('对手可见：易位的两个牌号（PUBLIC_SWAP_ACTION 默认 true）', () => {
    const s = swapPhase();
    const r = applySwap(s, 0, 3, 4); // A 的 3、4 同为暗牌 → 合法
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const foeView = getStateForPlayer(r.state, 1);
    const rec = foeView.swap.attempts.find((x) => x.player === 0);
    expect(rec).toBeTruthy();
    expect(rec!.slots).not.toBeNull();
    expect(rec!.slots!.length).toBe(2);
    expect(rec!.slots).toEqual([3, 4]);
    expect(rec!.valid).toBe(true);
  });

  it('非法易位记录公开，但绝不含明暗状态', () => {
    const s = swapPhase();
    const r = applySwap(s, 0, 1, 3); // A 的 1 明、3 暗 → 非法
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.swap.attempts[0].valid).toBe(false);
    for (const seat of [0, 1] as Seat[]) {
      const v = getStateForPlayer(r.state, seat);
      const rec = v.swap.attempts.find((x) => x.player === 0 && !x.valid);
      expect(rec).toBeTruthy();
      const text = JSON.stringify(rec);
      expect(text.includes('faceUp')).toBe(false);
      expect(text.includes('"value"')).toBe(false);
      expect(text.includes('明牌')).toBe(false);
      expect(text.includes('暗牌')).toBe(false);
    }
  });

  it('非法易位不推进阶段、不改变行动者', () => {
    const s = swapPhase();
    const r = applySwap(s, 0, 1, 3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.swap.acted[0]).toBe(false);
    expect(r.state.turn).toBe(0);
    expect(r.state.phase).toBe('swap');
  });
});

describe('11.10 下注阶段只泄露自己的牌', () => {
  it('自己的牌：明牌带 value，暗牌不含 value 键', () => {
    const s = betPhase('uudd', 'uudd', [1, 4, 8, 2], [8, 2, 1, 4]);
    const v0 = getStateForPlayer(s, 0);
    expect(v0.you.cards).toBeTruthy();
    expect(v0.you.cards!.length).toBe(4);
    expect(v0.you.cards![0]).toEqual({ slot: 1, faceUp: true, value: 1 });
    expect(v0.you.cards![1]).toEqual({ slot: 2, faceUp: true, value: 4 });
    expect(v0.you.cards![2]).toEqual({ slot: 3, faceUp: false });
    expect(v0.you.cards![3]).toEqual({ slot: 4, faceUp: false });
    expect(Object.prototype.hasOwnProperty.call(v0.you.cards![2], 'value')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(v0.you.cards![3], 'value')).toBe(false);
  });

  it('对手视图中不含对手牌对象与点数', () => {
    const s = betPhase('uudd', 'dddd', [1, 4, 8, 2], [8, 2, 1, 4]);
    const [v0, v1] = [getStateForPlayer(s, 0), getStateForPlayer(s, 1)] as [GameView, GameView];
    for (const v of [v0, v1]) {
      expect(hasKey(v.opponent, 'cards')).toBe(false);
      expect(hasKey(v.opponent, 'value')).toBe(false);
      expect(hasKey(v.opponent, 'faceUp')).toBe(false);
      expect(hasKey(v.opponent, 'board')).toBe(false);
    }
    // A 只能看到自己的明牌 1、4；B 全暗 → B 视角没有任何 value
    expect(collectValues(v0).slice().sort()).toEqual([1, 4]);
    expect(collectValues(v1)).toEqual([]);
  });

  it('牌的 id 绝不下发', () => {
    const s = betPhase();
    for (const seat of [0, 1] as Seat[]) {
      const text = JSON.stringify(getStateForPlayer(s, seat));
      expect(text.includes('"id"')).toBe(false);
      expect(text.includes('"A1"')).toBe(false);
      expect(text.includes('"B1"')).toBe(false);
    }
  });

  it('明牌总数在 bet 阶段下发，且等于服务端真实值', () => {
    const s = betPhase('uudd', 'dddd', [1, 4, 8, 2], [8, 2, 1, 4]);
    expect(getStateForPlayer(s, 0).bet.faceUpTotal).toBe(2);
    expect(getStateForPlayer(s, 1).bet.faceUpTotal).toBe(2);
  });

  it('视图内出现的每个 value 都必须来自自己的明牌', () => {
    const s = betPhase('uudd', 'dddd', [1, 4, 8, 2], [8, 2, 1, 4]);
    const v = getStateForPlayer(s, 0);
    const myValues = (v.you.cards ?? [])
      .filter((c) => c.faceUp)
      .map((c) => (c as { value: number }).value);
    expect(myValues.slice().sort()).toEqual([1, 4]);
    expect(collectValues(v).every((val) => myValues.includes(val))).toBe(true);
  });
});

describe('11.10 结算与结束阶段不自动公开牌面', () => {
  it('settle 阶段视图不含 cards', () => {
    let s = betPhase('dddd', 'uuuu');
    s = expectOk(applyStop(s, 0));
    const r = applyBet(s, 1, { type: 'bet', action: 'call' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.settlementResult).toBeTruthy();
    for (const seat of [0, 1] as Seat[]) {
      const v = getStateForPlayer(r.state, seat);
      expect(hasKey(v, 'cards')).toBe(false);
      expect(hasKey(v, 'value')).toBe(false);
      expect(hasKey(v, 'faceUp')).toBe(false);
    }
  });

  it('gameOver 阶段视图不含 cards', () => {
    const g = withBoards('uuuu', 'uuuu');
    g.players[0].chips = 1;
    const s = expectOk(beginBetPhase(g));
    expect(s.phase).toBe('gameOver');
    for (const seat of [0, 1] as Seat[]) {
      const v = getStateForPlayer(s, seat);
      expect(hasKey(v, 'cards')).toBe(false);
      expect(hasKey(v, 'value')).toBe(false);
    }
  });

  it('结算结果公开比分 / 赔付 / 扣除 / 破平标志', () => {
    const s0 = withBoards('uudd', 'uddu', 0, [1, 2, 4, 8], [8, 2, 4, 1]);
    const { state } = settleRound(expectOk(beginBetPhase(s0)));
    const v = getStateForPlayer(state, 0);
    expect(v.settlementResult).toBeTruthy();
    expect(v.settlementResult!.scores.length).toBe(2);
    expect(typeof v.settlementResult!.payment).toBe('number');
    expect(typeof v.settlementResult!.deduction).toBe('number');
    expect(typeof v.settlementResult!.winnerReceive).toBe('number');
    expect(typeof v.settlementResult!.tieBreak).toBe('boolean');
    // 结算结果里不含牌数据
    expect(collectKeys(v.settlementResult).has('faceUp')).toBe(false);
    expect(collectKeys(v.settlementResult).has('value')).toBe(false);
  });
});

describe('11.10 视图完整性：两位玩家的视图结构一致', () => {
  it('两个座位拿到的视图除个人字段外结构相同', () => {
    const s = betPhase();
    const v0 = getStateForPlayer(s, 0);
    const v1 = getStateForPlayer(s, 1);
    const k0 = [...collectKeys(v0)].sort();
    const k1 = [...collectKeys(v1)].sort();
    expect(k0).toEqual(k1);
    expect(v0.you.seat).toBe(0);
    expect(v1.you.seat).toBe(1);
    expect(v0.opponent.seat).toBe(1);
    expect(v1.opponent.seat).toBe(0);
  });

  it('视图不共享服务端状态引用（改动视图不影响 GameState）', () => {
    const s = betPhase();
    const before = JSON.stringify(s);
    const v = getStateForPlayer(s, 0);
    (v.you as { chips: number }).chips = 999999;
    (v.bet.bets as number[])[0] = 999999;
    if (v.you.cards) v.you.cards[0] = { slot: 1 as Slot, faceUp: false };
    expect(JSON.stringify(s)).toBe(before);
  });
});
