/**
 * 阶段 2 验收测试 —— 统一动作入口 applyAction / 自动结算 / 再来一局
 */
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  applyBet,
  applyStop,
  beginBetPhase,
  countFaceUp,
  rematch,
  type GameState,
} from '@zuolun/shared';
import { expectFail, expectOk, makeGame, seededRng, setBoard } from './helpers';

function betPhase(): GameState {
  const g = makeGame({ first: 0 });
  setBoard(g, 0, 'dddd');
  setBoard(g, 1, 'uuuu');
  return expectOk(beginBetPhase(g));
}

describe('applyAction 统一入口', () => {
  it('flip 动作经统一入口生效', () => {
    const g = makeGame({ first: 0 });
    const s = expectOk(applyAction(g, 0, { type: 'flip', slot: 3 }));
    expect(s.flip.acted[0]).toBe(true);
    expect(s.turn).toBe(1);
  });

  it('swap 动作经统一入口生效（非法组合被拒但不改状态）', () => {
    let g = makeGame({ first: 0 });
    setBoard(g, 0, 'dudd');
    setBoard(g, 1, 'uddu');
    g = expectOk(applyAction(g, 0, { type: 'flip', slot: 1 }));
    g = expectOk(applyAction(g, 1, { type: 'flip', slot: 1 }));
    expect(g.phase).toBe('swap');
    const bad = applyAction(g, 0, { type: 'swap', slots: [1, 2] });
    expect(bad.ok).toBe(true);
    if (!bad.ok) return;
    expect(bad.state.swap.acted[0]).toBe(false);
  });

  it('swap 载荷格式非法 → BAD_SLOTS', () => {
    const g = makeGame({ first: 0 });
    expect(expectFail(applyAction(g, 0, { type: 'swap', slots: [1] as never }))).toBe('BAD_SLOTS');
  });

  it('bet 动作在满足结束条件时自动结算', () => {
    let s = betPhase();
    s = expectOk(applyAction(s, 0, { type: 'bet', action: 'stop' }));
    const r = applyAction(s, 1, { type: 'bet', action: 'call' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.settlementResult).toBeTruthy();
    expect(r.state.bet.finished).toBe(true);
  });

  it('bet 动作未结束时不做结算', () => {
    const s = betPhase();
    const r = applyAction(s, 0, { type: 'bet', action: 'call' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.settlementResult).toBeUndefined();
    expect(r.state.phase).toBe('bet');
  });

  it('未知动作类型 → BAD_ACTION', () => {
    const g = makeGame({ first: 0 });
    expect(expectFail(applyAction(g, 0, { type: 'nope' } as never))).toBe('BAD_ACTION');
  });
});

describe('结算触发（applyBet / applyStop 内部自动结算）', () => {
  it('下注阶段未结束时不做结算', () => {
    const s = betPhase();
    const r = applyBet(s, 0, { type: 'bet', action: 'call' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.settlementResult).toBeUndefined();
    expect(r.state.phase).toBe('bet');
    expect(r.state.bet.finished).toBe(false);
  });

  it('满足结束条件时立即结算（无需外部再调用）', () => {
    const s = betPhase();
    // 先手跟注 → 尚未结束
    const mid = applyBet(s, 0, { type: 'bet', action: 'call' });
    expect(mid.ok).toBe(true);
    if (!mid.ok) return;
    expect(mid.state.bet.finished).toBe(false);
    // 后手停注 → 立即结算
    const r = applyStop(mid.state, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.bet.finished).toBe(true);
    expect(r.state.settlementResult).toBeTruthy();
    expect(r.state.phase).toBe('settle');
  });

  it('先手停注后，后手再行动一次即自动结算', () => {
    const s = betPhase();
    const stopped = applyStop(s, 0);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(stopped.state.bet.finished).toBe(false);
    const r = applyBet(stopped.state, 1, { type: 'bet', action: 'call' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.bet.finished).toBe(true);
    expect(r.state.settlementResult).toBeTruthy();
  });
});

describe('rematch（再来一局）', () => {
  it('保持模式与昵称、重置轮次与筹码、重新洗牌', () => {
    const g = makeGame({ mode: 'extreme', names: ['甲', '乙'], first: 0 });
    g.players[0].chips = 3;
    g.round = 7;
    const r = rematch(g, { initialFirst: 1, rng: seededRng(999) });
    expect(r.mode).toBe('extreme');
    expect(r.players.map((p) => p.name)).toEqual(['甲', '乙']);
    expect(r.players.map((p) => p.chips)).toEqual([16, 16]);
    expect(r.round).toBe(1);
    expect(r.first).toBe(1);
    expect(r.phase).toBe('flip');
    expect(r.players.every((p) => p.board.every((c) => !c.faceUp))).toBe(true);
    expect(countFaceUp(r)).toBe(0);
  });
});
