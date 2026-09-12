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
      // 带引号匹配真实键名（faceUpTotal 含子串 faceUp，不可用裸子串判断）
      expect(text.includes('"faceUp"')).toBe(false);
    }
  });

  it('行动者自己也察觉不到自己的牌发生了变化（翻转后视图与翻转前同构）', () => {
    // 核心约束：翻转阶段双方都不知道牌面变化 ——
    // 连「我选了 n 号、我的 n 号牌到底翻没翻」都不能被行动者本人观测。
    const g = withBoards('uudd', 'uddu', 0, [1, 2, 4, 8], [8, 2, 4, 1]);
    const before = getStateForPlayer(g, 0);
    const r = applyFlip(g, 0, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = getStateForPlayer(r.state, 0);

    // 选出「与这次翻转结果有关」的全部可观测字段：必须完全相同
    const observable = (v: typeof before) => ({
      round: v.round,
      phase: v.phase,
      status: v.status,
      opponent: v.opponent,
      bet: v.bet,
    });
    expect(observable(after)).toEqual(observable(before));
    // 行动者视角里绝不出现任何牌对象或点数
    expect(hasKey(after, 'cards')).toBe(false);
    expect(hasKey(after, 'value')).toBe(false);
  });

  it('翻转阶段双方拿到的可观测信息完全对称（不因身份而不同）', () => {
    const g = withBoards('uudd', 'uddu', 0, [1, 2, 4, 8], [8, 2, 4, 1]);
    // 翻转前
    for (const s of [g, (() => {
      const r = applyFlip(g, 0, 1);
      if (!r.ok) throw new Error('flip failed');
      return r.state;
    })()]) {
      const v0 = getStateForPlayer(s, 0);
      const v1 = getStateForPlayer(s, 1);
      // 除 turn / youActed（各自视角）外，可观测字段必须一致
      expect(v0.phase).toBe(v1.phase);
      expect(v0.round).toBe(v1.round);
      expect(v0.first).toBe(v1.first);
      expect(v0.second).toBe(v1.second);
      expect(v0.status).toBe(v1.status);
      expect(JSON.stringify(v0.bet)).toBe(JSON.stringify(v1.bet));
      // 双方都不含任何牌信息
      expect(hasKey(v0, 'cards')).toBe(false);
      expect(hasKey(v1, 'cards')).toBe(false);
      expect(hasKey(v0, 'flip')).toBe(false);
      expect(hasKey(v1, 'flip')).toBe(false);
    }
  });

  it('youActed 只反映自己，绝不暴露对手行动状态', () => {
    const g = withBoards('uudd', 'uddu', 0, [1, 2, 4, 8], [8, 2, 4, 1]);
    const r = applyFlip(g, 0, 1); // 先手(0)已翻转，轮到后手(1)
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v0 = getStateForPlayer(r.state, 0);
    const v1 = getStateForPlayer(r.state, 1);
    expect(v0.youActed).toBe(true); // 自己已行动
    expect(v1.youActed).toBe(false); // 对手视角：自己尚未行动
    // 关键：1 号视角无法从任何字段推断出「0 号已经行动过了」
    expect(hasKey(v1, 'acted')).toBe(false);
    expect(hasKey(v1, 'flip')).toBe(false);
    expect(JSON.stringify(v1).includes('"acted"')).toBe(false);
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

  it('易位的两个牌号绝不公开（会泄露「同状态才可易位」这条暗规则）', () => {
    const s = swapPhase();
    const r = applySwap(s, 0, 3, 4); // A 的 3、4 同为暗牌 → 合法
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const seat of [0, 1] as Seat[]) {
      const v = getStateForPlayer(r.state, seat);
      // 视图里不存在 swap 字段
      expect(hasKey(v, 'swap')).toBe(false);
      const text = JSON.stringify(v);
      expect(text.includes('"attempts"')).toBe(false);
      expect(text.includes('"slots"')).toBe(false);
      expect(text.includes('"valid"')).toBe(false);
    }
  });

  it('非法易位尝试绝不公开（会暴露牌的明暗状态）', () => {
    const s = swapPhase();
    const r = applySwap(s, 0, 1, 3); // A 的 1 明、3 暗 → 非法
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 内部状态确实记录了这次非法尝试（供服务端裁决用）
    expect(r.state.swap.attempts.length).toBe(1);
    // 但不下发到任何玩家的视图
    for (const seat of [0, 1] as Seat[]) {
      const v = getStateForPlayer(r.state, seat);
      expect(hasKey(v, 'swap')).toBe(false);
      const text = JSON.stringify(v);
      expect(text.includes('非法')).toBe(false);
      // 注意用带引号的精确键名匹配：键 faceUpTotal 含子串 "faceUp"，会造成误判
      expect(text.includes('"faceUp"')).toBe(false);
      expect(text.includes('"value"')).toBe(false);
      expect(text.includes('"slots"')).toBe(false);
    }
  });

  it('翻转阶段的行动记录不公开（不暴露对手进度）', () => {
    const g = withBoards('uudd', 'uddu', 0, [1, 2, 4, 8], [8, 2, 4, 1]);
    const afterFirst = expectOk(applyFlip(g, 0, 1)); // 先手已完成翻转
    for (const seat of [0, 1] as Seat[]) {
      const v = getStateForPlayer(afterFirst, seat);
      expect(hasKey(v, 'flip')).toBe(false);
      const text = JSON.stringify(v);
      expect(text.includes('"acted"')).toBe(false);
      expect(text.includes('"attempts"')).toBe(false);
    }
  });

  it('下注阶段不公开「谁已停注/易位细节」以外的暗规则信息', () => {
    const s = betPhase();
    const v = getStateForPlayer(s, 0);
    // 明牌总数在下注阶段是规则明确要求公开的
    expect(v.bet.faceUpTotal).toBe(4);
    // 但不得包含任何牌位级别的对手信息
    expect(hasKey(v.opponent, 'cards')).toBe(false);
    expect(hasKey(v, 'flip')).toBe(false);
    expect(hasKey(v, 'swap')).toBe(false);
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

  it('结算结果不下发 lastBrightOwner / tieBreakStarter（会反推牌面状态）', () => {
    const s0 = withBoards('uudd', 'uddu', 0, [1, 2, 4, 8], [8, 2, 4, 1]);
    const { state } = settleRound(expectOk(beginBetPhase(s0)));
    // 服务端内部仍然保留这两个字段（用于判定与日志）
    expect(state.settlementResult).toHaveProperty('lastBrightOwner');
    expect(state.settlementResult).toHaveProperty('tieBreakStarter');
    // 但下行视图里必须没有
    for (const seat of [0, 1] as Seat[]) {
      const v = getStateForPlayer(state, seat);
      const text = JSON.stringify(v.settlementResult);
      expect(text.includes('lastBrightOwner')).toBe(false);
      expect(text.includes('tieBreakStarter')).toBe(false);
      expect(v.settlementResult).not.toHaveProperty('lastBrightOwner');
      expect(v.settlementResult).not.toHaveProperty('tieBreakStarter');
    }
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
