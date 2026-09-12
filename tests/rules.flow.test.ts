/**
 * 阶段 2 验收测试 —— 多轮对局集成（不变量守护、先后手交替、终局）
 * 对应 docs/rules-spec.md §2.1 不变量与 §11.9。
 */
import { describe, expect, it } from 'vitest';
import {
  advanceRound,
  applyBet,
  applyFlip,
  applyStop,
  applySwap,
  createGame,
  type GameState,
  type Seat,
  type Slot,
} from '@zuolun/shared';
import { boardValues, expectOk, seededRng } from './helpers';

/**
 * 校验 docs/rules-spec.md §2.1 的全部不变量。
 *
 * 筹码记账模型（与引擎实现严格对应，已用多轮对局实测校正）：
 *  - 下注时筹码从玩家手上划入 `bet.pot`（托管）。
 *  - 结算：败方从筹码中支付 payment；胜方当场收下整池 N 的净收益 `N − payment`；
 *    被扣除的 deduction 永久移出游戏。因此每一轮结算后，场上筹码净减少 exactly `deduction`。
 *  - 记账公式（对任意轮次、任意阶段成立）：
 *      Σ(双方筹码) + Σ(已完成轮次的 deduction) + 本轮 deduction === 开局筹码总和
 *    注：已结算轮的 pot 仅是历史记录，其筹码已分配完毕，不再计入守恒式。
 *
 * @param settledDeductions 已完成轮次的 deduction 累计（永久移出游戏的筹码）
 * @param currentDeduction  当前轮已产生的 deduction（未结算轮次为 0）
 */
function assertInvariants(
  g: GameState,
  initialTotal: number,
  settledDeductions: number,
  currentDeduction = 0,
): void {
  // I1 每方 4 张牌
  expect(g.players[0].board.length).toBe(4);
  expect(g.players[1].board.length).toBe(4);
  // I2/I3 全服牌集合恒为 {1,2,4,8}×2
  const all = [...boardValues(g, 0), ...boardValues(g, 1)].slice().sort((a, b) => a - b);
  expect(all).toEqual([1, 1, 2, 2, 4, 4, 8, 8]);
  // I4 pot === bets 之和
  expect(g.bet.pot).toBe(g.bet.bets[0] + g.bet.bets[1]);
  // I5 筹码守恒
  //   Σchips + 累计扣除 + 在场总注 === 开局总额
  // 注：pot 中累计着此前各轮被扣除的筹码，故必须计入。
  expect(g.players[0].chips + g.players[1].chips + settledDeductions + currentDeduction + g.bet.pot).toBe(
    initialTotal,
  );
  // I6 筹码非负
  expect(g.players[0].chips).toBeGreaterThanOrEqual(0);
  expect(g.players[1].chips).toBeGreaterThanOrEqual(0);
  // I9 先手推算
  expect(g.first).toBe(((g.initialFirst + g.round - 1) % 2) as Seat);
  expect(g.second).toBe(1 - g.first);
}

function pickSameStatePair(g: GameState, seat: Seat): [Slot, Slot] | null {
  const b = g.players[seat].board;
  for (let i = 1 as Slot; i <= 4; i++) {
    for (let j = (i + 1) as Slot; j <= 4; j++) {
      if (b[i - 1].faceUp === b[j - 1].faceUp) return [i, j];
    }
  }
  return null;
}

/**
 * 自动打完一整轮（翻转 → 易位 → 下注 → 结算）。
 * 下注策略：先手尽量跟注（筹码不足或超上限时改为停注），后手停注 → 自动结算。
 */
function playRound(state: GameState): { state: GameState; deduction: number; pot: number } {
  let s = state;
  // --- flip：先手先行动，后手后行动（各自恰好一次）---
  s = expectOk(applyFlip(s, s.first, 1));
  if (!s.flip.acted[s.second]) {
    s = expectOk(applyFlip(s, s.second, 2));
  }
  expect(s.phase).toBe('swap');
  // --- swap：先手、后手依次 ---
  for (const seat of [s.first, s.second]) {
    const pair = pickSameStatePair(s, seat);
    expect(pair).not.toBeNull();
    s = expectOk(applySwap(s, seat, pair![0], pair![1]));
  }
  if (s.phase === 'gameOver') return { state: s, deduction: 0, pot: 0 };
  expect(s.phase).toBe('bet');
  // --- bet ---
  const canCall = s.players[s.first].chips >= 2 && s.bet.bets[s.first] + 2 <= s.bet.limitBase[s.first];
  s = canCall
    ? expectOk(applyBet(s, s.first, { type: 'bet', action: 'call' }))
    : expectOk(applyStop(s, s.first));
  s = expectOk(applyStop(s, s.second));
  expect(s.settlementResult).toBeTruthy();
  const r = s.settlementResult!;
  return { state: s, deduction: r.deduction, pot: r.pot };
}

describe('多轮对局集成', () => {
  it('完整一轮走通：flip → swap → bet → settle', () => {
    const g = createGame({ mode: 'normal', names: ['A', 'B'], initialFirst: 0, rng: seededRng(7) });
    const out = playRound(g);
    const s = out.state;
    expect(s.settlementResult).toBeTruthy();
    expect(s.phase === 'settle' || s.phase === 'gameOver').toBe(true);
    const r = s.settlementResult!;
    expect(r.scores[0] === r.scores[1]).toBe(false);
    expect(r.pot).toBe(s.bet.pot);
    assertInvariants(s, 128, 0, out.deduction); // 结算当刻
  });

  it('结算后 advanceRound 进入下一轮并交换先后手', () => {
    const g = createGame({ mode: 'normal', names: ['A', 'B'], initialFirst: 0, rng: seededRng(11) });
    const out = playRound(g);
    const s1 = out.state;
    if (s1.phase !== 'settle') return; // 本轮若直接结束则跳过
    const s2 = advanceRound(s1);
    expect(s2.round).toBe(2);
    expect(s2.first).toBe(1);
    expect(s2.second).toBe(0);
    expect(s2.phase).toBe('flip');
    // 进入下一轮：pot 归零、本轮临时状态清空；筹码与牌局状态保留
    expect(s2.bet.pot).toBe(0);
    expect(s2.bet.bets).toEqual([0, 0]);
    expect(s2.flip.acted).toEqual([false, false]);
    expect(s2.players.map((p) => p.chips)).toEqual(s1.players.map((p) => p.chips));
  });

  it('单轮筹码守恒：结算不凭空创造筹码', () => {
    // 隔离轮验证：新对局首轮，Σ筹码 + 在场总注 + 本轮扣除 必等于开局筹码总额。
    for (const seed of [1, 2, 3, 7, 11, 42, 2024]) {
      for (const mode of ['normal', 'extreme'] as const) {
        const total = mode === 'normal' ? 128 : 32;
        const g = createGame({
          mode,
          names: ['A', 'B'],
          initialFirst: (seed % 2) as Seat,
          rng: seededRng(seed),
        });
        expect(g.players[0].chips + g.players[1].chips + g.bet.pot).toBe(total);
        const out = playRound(g);
        const s = out.state;
        const r = s.settlementResult!;
        expect(s.players[0].chips + s.players[1].chips + s.bet.pot + out.deduction).toBe(total);
        // 被扣除 = 败方实付 − 胜方实收（这正是「扣除的筹码移出游戏」）
        expect(r.deduction).toBe(r.actualPaid - r.winnerReceive);
      }
    }
  });

  it('多轮连续对局：筹码总量永不增长，直到分出胜负', () => {
    for (const seed of [5, 17, 2024]) {
      let s = createGame({ mode: 'extreme', names: ['A', 'B'], initialFirst: 0, rng: seededRng(seed) });
      let rounds = 0;
      for (let i = 0; i < 8 && s.status !== 'gameOver'; i++) {
        const out = playRound(s);
        s = out.state;
        // 手上筹码 + 在场总注 不得增长（pot 内累计历史扣除，故只会更小）
        expect(s.players[0].chips + s.players[1].chips + s.bet.pot).toBeLessThanOrEqual(32);
        if (s.phase !== 'settle') break;
        s = advanceRound(s);
        rounds += 1;
      }
      expect(rounds).toBeGreaterThan(0);
      if (s.status === 'gameOver') {
        expect(s.gameOver).toBeTruthy();
        expect([0, 1]).toContain(s.gameOver!.winner);
      }
    }
  });

  it('先后手逐轮交替（连续多轮）', () => {
    let s = createGame({ mode: 'normal', names: ['A', 'B'], initialFirst: 1, rng: seededRng(5) });
    const seen: Seat[] = [];
    for (let i = 0; i < 6; i++) {
      if (s.status === 'gameOver') break;
      seen.push(s.first);
      const out = playRound(s);
      s = out.state;
      if (s.phase === 'settle') s = advanceRound(s);
    }
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBe(1 - seen[i - 1]);
    }
    expect(seen[0]).toBe(1);
  });

  it('牌局跨轮保留：不重洗（同一张牌 id 的值不变）', () => {
    const g = createGame({ mode: 'normal', names: ['A', 'B'], initialFirst: 0, rng: seededRng(31) });
    const before = g.players.map((p) => p.board.map((c) => `${c.id}:${c.value}`).sort().join(','));
    const { state: s1 } = playRound(g);
    const after = s1.players.map((p) => p.board.map((c) => `${c.id}:${c.value}`).sort().join(','));
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });

  it('多个随机种子下均能跑完若干轮，且每轮牌集合与筹码上界均成立', () => {
    for (let seed = 1; seed <= 20; seed++) {
      let s = createGame({
        mode: 'extreme',
        names: ['A', 'B'],
        initialFirst: (seed % 2) as Seat,
        rng: seededRng(seed),
      });
      let previousTotal = 32;
      for (let i = 0; i < 5 && s.status !== 'gameOver'; i++) {
        // 牌集合不变量
        const all = [...boardValues(s, 0), ...boardValues(s, 1)].slice().sort((a, b) => a - b);
        expect(all).toEqual([1, 1, 2, 2, 4, 4, 8, 8]);
        // 先手推算
        expect(s.first).toBe(((s.initialFirst + s.round - 1) % 2) as Seat);
        const out = playRound(s);
        s = out.state;
        const liveTotal = s.players[0].chips + s.players[1].chips + s.bet.pot;
        // 筹码只减不增：本轮结束时不得多于上一轮开始时的场上筹码
        expect(liveTotal).toBeLessThanOrEqual(previousTotal);
        if (s.phase !== 'settle') break;
        s = advanceRound(s);
        previousTotal = s.players[0].chips + s.players[1].chips + s.bet.pot;
      }
    }
  });
});
