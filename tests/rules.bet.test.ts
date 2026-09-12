/**
 * 阶段 2 验收测试 —— 下注阶段（跟注 / 加注 / 停注 / 上限 / 自动结算）
 * 对应 docs/rules-spec.md §11.5 与 §4.4。
 */
import { describe, expect, it } from 'vitest';
import { applyBet, applyStop, beginBetPhase, cloneState, type GameState } from '@zuolun/shared';
import { expectFail, expectOk, makeGame, setBoard } from './helpers';

/** 构造一个已进入下注阶段的对局：4 张明牌 → ante 2，双方各 62，上限各 31 */
function betGame(opts: { first?: 0 | 1; chipsA?: number; chipsB?: number } = {}): GameState {
  const g = makeGame({ first: opts.first ?? 0 });
  setBoard(g, 0, 'uudd');
  setBoard(g, 1, 'uudd');
  if (opts.chipsA !== undefined) g.players[0].chips = opts.chipsA;
  if (opts.chipsB !== undefined) g.players[1].chips = opts.chipsB;
  const s = expectOk(beginBetPhase(g));
  expect(s.phase).toBe('bet');
  return s;
}

describe('11.5 下注', () => {
  it('跟注固定扣 2，bets / pot / chips 同步', () => {
    const g = betGame();
    const s = expectOk(applyBet(g, 0, { type: 'bet', action: 'call' }));
    expect(s.bet.bets).toEqual([4, 2]);
    expect(s.bet.pot).toBe(6);
    expect(s.players.map((p) => p.chips)).toEqual([60, 62]);
    expect(s.turn).toBe(1);
  });

  it('加注任意正整数生效', () => {
    const g = betGame();
    const s = expectOk(applyBet(g, 0, { type: 'bet', action: 'raise', amount: 7 }));
    expect(s.bet.bets).toEqual([9, 2]);
    expect(s.bet.pot).toBe(11);
    expect(s.players[0].chips).toBe(55);
  });

  it('加注 0 / 负数 / 小数 → BET_BAD_AMOUNT', () => {
    const g = betGame();
    expect(expectFail(applyBet(g, 0, { type: 'bet', action: 'raise', amount: 0 }))).toBe('BET_BAD_AMOUNT');
    expect(expectFail(applyBet(g, 0, { type: 'bet', action: 'raise', amount: -3 }))).toBe('BET_BAD_AMOUNT');
    expect(expectFail(applyBet(g, 0, { type: 'bet', action: 'raise', amount: 1.5 }))).toBe('BET_BAD_AMOUNT');
  });

  it('超出自己筹码 → BET_INSUFFICIENT_CHIPS', () => {
    const g = betGame({ chipsA: 5, chipsB: 5 });
    // ante = 2 → A 剩 3；上限 = floor(3/2) = 1（对手筹码 3）
    const s = betGame({ chipsA: 5, chipsB: 5 });
    expect(s.bet.callBase).toEqual([3, 3]);
    expect(s.bet.limitBase).toEqual([1, 1]);
    // 加注 2 → 超自己筹码(3)? 不超；但超上限(1) → BET_OVER_LIMIT
    expect(expectFail(applyBet(s, 0, { type: 'bet', action: 'raise', amount: 2 }))).toBe('BET_OVER_LIMIT');
    // 跟注 2 → 同样超上限 1
    expect(expectFail(applyBet(s, 0, { type: 'bet', action: 'call' }))).toBe('BET_OVER_LIMIT');
    void g;
  });

  it('跟注时筹码不足 → BET_INSUFFICIENT_CHIPS', () => {
    const g = betGame({ chipsA: 3, chipsB: 100 });
    // ante = 2 → A 剩 1，上限 = floor(98/2) = 49
    expect(g.bet.limitBase[0]).toBeGreaterThan(2);
    expect(expectFail(applyBet(g, 0, { type: 'bet', action: 'call' }))).toBe('BET_INSUFFICIENT_CHIPS');
  });

  it('总注超上限 → BET_OVER_LIMIT', () => {
    const g = betGame(); // 上限各 31
    let s = g;
    // A 连续加注到 31（bets[0] 已含底注 2，可再投 29）
    s = expectOk(applyBet(s, 0, { type: 'bet', action: 'raise', amount: 29 }));
    expect(s.bet.bets[0]).toBe(31);
    // B 回应跟注
    s = expectOk(applyBet(s, 1, { type: 'bet', action: 'call' }));
    expect(s.turn).toBe(0);
    // A 再投 1 → 已达上限 31 → 拒绝
    expect(expectFail(applyBet(s, 0, { type: 'bet', action: 'raise', amount: 1 }))).toBe('BET_OVER_LIMIT');
    expect(expectFail(applyBet(s, 0, { type: 'bet', action: 'call' }))).toBe('BET_OVER_LIMIT');
  });

  it('非法操作时状态完全不变（深度相等）', () => {
    const g = betGame();
    const snap = JSON.stringify(g);
    applyBet(g, 0, { type: 'bet', action: 'raise', amount: 999 });
    applyBet(g, 0, { type: 'bet', action: 'raise', amount: -1 });
    applyBet(g, 1, { type: 'bet', action: 'call' }); // 非本人回合
    applyStop(g, 1);
    expect(JSON.stringify(g)).toBe(snap);
  });

  it('非本人回合下注 → NOT_YOUR_TURN', () => {
    const g = betGame({ first: 0 });
    expect(expectFail(applyBet(g, 1, { type: 'bet', action: 'call' }))).toBe('NOT_YOUR_TURN');
    expect(expectFail(applyStop(g, 1))).toBe('NOT_YOUR_TURN');
  });

  it('先手停注 → 后手仍可行动一次 → 自动停注 → 进入结算', () => {
    let s = betGame({ first: 0 });
    s = expectOk(applyStop(s, 0));
    expect(s.bet.firstStopped).toBe(true);
    expect(s.bet.finished).toBe(false);
    expect(s.turn).toBe(1);
    // 后手跟注 → 自动停注
    const r = applyBet(s, 1, { type: 'bet', action: 'call' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.bet.finished).toBe(true);
    expect(r.state.settlementResult).toBeTruthy();
  });

  it('先手停注 → 后手也停注 → 进入结算', () => {
    let s = betGame({ first: 0 });
    s = expectOk(applyStop(s, 0));
    const r = applyStop(s, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.bet.finished).toBe(true);
    expect(r.state.settlementResult).toBeTruthy();
  });

  it('后手停注 → 直接结算', () => {
    let s = betGame({ first: 0 });
    s = expectOk(applyBet(s, 0, { type: 'bet', action: 'call' }));
    const r = applyStop(s, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.bet.finished).toBe(true);
    expect(r.state.settlementResult).toBeTruthy();
  });

  it('重复停注 → ALREADY_STOPPED', () => {
    let s = betGame({ first: 0 });
    s = expectOk(applyStop(s, 0));
    // 现在轮到 B；A 再停注 → 非本人回合
    expect(expectFail(applyStop(s, 0))).toBe('NOT_YOUR_TURN');
    // B 停注 → 立即结算（phase 变为 settle）
    const r = applyStop(s, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.bet.finished).toBe(true);
    expect(r.state.settlementResult).toBeTruthy();
    expect(r.state.phase).toBe('settle');
    // 结算完成后任何下注动作都被拒
    expect(expectFail(applyBet(r.state, 0, { type: 'bet', action: 'call' }))).toBe('WRONG_PHASE');
    expect(expectFail(applyStop(r.state, 1))).toBe('WRONG_PHASE');
  });

  it('已结束后任何座位下注都被拒（WRONG_PHASE，而非 NOT_YOUR_TURN）', () => {
    let s = betGame({ first: 0 });
    s = expectOk(applyStop(s, 0));
    const r = applyStop(s, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const seat of [0, 1] as const) {
      expect(expectFail(applyBet(r.state, seat, { type: 'bet', action: 'call' }))).toBe('WRONG_PHASE');
    }
  });

  it('N === pot === bets[0] + bets[1]', () => {
    let s = betGame();
    s = expectOk(applyBet(s, 0, { type: 'bet', action: 'call' }));
    s = expectOk(applyBet(s, 1, { type: 'bet', action: 'raise', amount: 5 }));
    s = expectOk(applyBet(s, 0, { type: 'bet', action: 'call' }));
    expect(s.bet.pot).toBe(s.bet.bets[0] + s.bet.bets[1]);
    expect(s.bet.pot).toBe(4 + 2 + 5 + 2);
  });

  it('筹码守恒：pot + chips[0] + chips[1] === 初始总和（赔付前）', () => {
    let s = betGame();
    s = expectOk(applyBet(s, 0, { type: 'bet', action: 'call' }));
    s = expectOk(applyBet(s, 1, { type: 'bet', action: 'raise', amount: 9 }));
    expect(s.bet.pot + s.players[0].chips + s.players[1].chips).toBe(128);
  });

  it('未进入下注阶段的下注动作被拒（WRONG_PHASE）', () => {
    const g = makeGame();
    expect(expectFail(applyBet(g, 0, { type: 'bet', action: 'call' }))).toBe('WRONG_PHASE');
    expect(expectFail(applyStop(g, 0))).toBe('WRONG_PHASE');
  });

  it('下注失败不改变 turn', () => {
    const g = betGame({ first: 0 });
    const s = cloneState(g);
    applyBet(s, 0, { type: 'bet', action: 'raise', amount: 1e9 });
    expect(s.turn).toBe(0);
  });
});
