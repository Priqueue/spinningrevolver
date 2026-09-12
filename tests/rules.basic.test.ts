/**
 * 阶段 2 验收测试 —— 建局 / 翻转 / 易位 / 底注 / 轮次
 * 对应 AGENT_GUIDE.txt 第 10 节「规则引擎」清单与 docs/rules-spec.md §11.1~11.4。
 */
import { describe, expect, it } from 'vitest';
import {
  applyFlip,
  applySwap,
  beginBetPhase,
  calculateAnte,
  ceilDiv,
  cloneState,
  countFaceUp,
  createGame,
  firstOf,
  startRound,
} from '@zuolun/shared';
import type { GameState } from '@zuolun/shared';
import {
  boardLayout,
  boardValues,
  doBothFlips,
  expectFail,
  expectOk,
  makeGame,
  seededRng,
  setBoard,
} from './helpers';

describe('11.1 洗牌与初始化', () => {
  it('每副牌恒为 {1,2,4,8}，两副合计各两张', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const g = createGame({ mode: 'normal', rng: seededRng(seed) });
      const all = [...boardValues(g, 0), ...boardValues(g, 1)];
      expect(all.slice().sort((x, y) => x - y)).toEqual([1, 1, 2, 2, 4, 4, 8, 8]);
    }
  });

  it('开局所有牌均为暗牌', () => {
    const g = makeGame();
    expect(boardLayout(g, 0)).toBe('dddd');
    expect(boardLayout(g, 1)).toBe('dddd');
  });

  it('正常模式 64/64，极限模式 16/16', () => {
    expect(makeGame({ mode: 'normal' }).players.map((p) => p.chips)).toEqual([64, 64]);
    expect(makeGame({ mode: 'extreme' }).players.map((p) => p.chips)).toEqual([16, 16]);
  });

  it('第 1 轮先手 = initialFirst，轮次从 1 开始', () => {
    expect(makeGame({ first: 0 }).first).toBe(0);
    expect(makeGame({ first: 1 }).first).toBe(1);
    expect(makeGame({ first: 0 }).round).toBe(1);
    expect(makeGame({ first: 0 }).phase).toBe('flip');
    expect(makeGame({ first: 0 }).turn).toBe(0);
  });

  it('非法模式被拒绝', () => {
    expect(() => createGame({ mode: 'huge' as never })).toThrow('BAD_MODE');
  });
});

describe('11.2 翻转', () => {
  it('同为暗牌 → 只翻转自己的 n 号牌（变明）', () => {
    const g = makeGame();
    setBoard(g, 0, 'dddd');
    setBoard(g, 1, 'dddd');
    const s = expectOk(applyFlip(g, 0, 2));
    expect(boardLayout(s, 0)).toBe('dudd');
    expect(boardLayout(s, 1)).toBe('dddd');
    expect(countFaceUp(s)).toBe(1);
  });

  it('同为明牌 → 只翻转自己的 n 号牌（变暗）', () => {
    const g = makeGame();
    setBoard(g, 0, 'uuuu');
    setBoard(g, 1, 'uuuu');
    const s = expectOk(applyFlip(g, 0, 3));
    expect(boardLayout(s, 0)).toBe('uudu');
    expect(boardLayout(s, 1)).toBe('uuuu');
    expect(countFaceUp(s)).toBe(7);
  });

  it('状态不同 → 交换双方 n 号牌（明暗归属互换，明牌总数不变）', () => {
    const g = makeGame();
    // A: 1号暗, 2号明 / B: 1号明, 2号暗
    setBoard(g, 0, 'dudd');
    setBoard(g, 1, 'uddd');
    const before = countFaceUp(g);
    const a1 = boardValues(g, 0)[0];
    const b1 = boardValues(g, 1)[0];
    const s = expectOk(applyFlip(g, 0, 1));
    expect(boardValues(s, 0)[0]).toBe(b1);
    expect(boardValues(s, 1)[0]).toBe(a1);
    expect(boardLayout(s, 0)[0]).toBe('u'); // 拿到 B 的明牌
    expect(boardLayout(s, 1)[0]).toBe('d'); // 拿到 A 的暗牌
    expect(countFaceUp(s)).toBe(before);
  });

  it('交换后牌值集合仍合法（I2/I3 不变量）', () => {
    const g = makeGame();
    setBoard(g, 0, 'duud', [8, 4, 2, 1]);
    setBoard(g, 1, 'uddu', [1, 2, 4, 8]);
    const s = expectOk(applyFlip(g, 0, 2));
    const all = [...boardValues(s, 0), ...boardValues(s, 1)].sort((x, y) => x - y);
    expect(all).toEqual([1, 1, 2, 2, 4, 4, 8, 8]);
  });

  it('非本人回合被拒（且状态零变更）', () => {
    const g = makeGame({ first: 0 });
    expect(expectFail(applyFlip(g, 1, 1))).toBe('NOT_YOUR_TURN');
  });

  it('重复行动被拒', () => {
    const g = makeGame({ first: 0 });
    const s = expectOk(applyFlip(g, 0, 1));
    expect(expectFail(applyFlip(s, 0, 2))).toBe('NOT_YOUR_TURN'); // 已轮到对方
  });

  it('非法牌位被拒', () => {
    const g = makeGame({ first: 0 });
    expect(expectFail(applyFlip(g, 0, 0 as never))).toBe('BAD_SLOT');
    expect(expectFail(applyFlip(g, 0, 5 as never))).toBe('BAD_SLOT');
  });

  it('失败路径不修改入参（状态零变更）', () => {
    const g = makeGame();
    setBoard(g, 0, 'dudd');
    const snapshot = JSON.stringify(g);
    applyFlip(g, 1, 1);
    applyFlip(g, 0, 9 as never);
    expect(JSON.stringify(g)).toBe(snapshot);
  });

  it('双方完成后进入易位阶段，行动者回到先手', () => {
    const g = makeGame({ first: 0 });
    const mid = expectOk(applyFlip(g, 0, 1));
    expect(mid.phase).toBe('flip');
    expect(mid.turn).toBe(1);
    const s = expectOk(applyFlip(mid, 1, 1));
    expect(s.phase).toBe('swap');
    expect(s.turn).toBe(0);
    expect(s.flip.acted).toEqual([true, true]);
  });

  it('后手先被翻转时，先手仍是先行动者（顺序由 first 决定）', () => {
    const g = makeGame({ first: 1 });
    const mid = expectOk(applyFlip(g, 1, 1));
    expect(mid.turn).toBe(0);
    const s = expectOk(applyFlip(mid, 0, 1));
    expect(s.phase).toBe('swap');
    expect(s.turn).toBe(1);
  });
});

describe('11.3 易位', () => {
  function flipPhaseGame(first: 0 | 1 = 0): GameState {
    const g = makeGame({ first });
    setBoard(g, 0, 'duud'); // 1明 2暗 3暗 4明
    setBoard(g, 1, 'uddu'); // 1暗 2明 3明 4暗
    return doBothFlips(g);
  }

  it('同状态 → 位置互换且 acted=true', () => {
    const g = flipPhaseGame();
    const before = boardValues(g, 0);
    const s = expectOk(applySwap(g, 0, 2, 3)); // 2、3 同为暗牌
    expect(boardValues(s, 0)).toEqual([before[0], before[2], before[1], before[3]]);
    expect(s.swap.acted[0]).toBe(true);
    expect(s.turn).toBe(1);
  });

  it('不同状态 → 非法易位：牌局状态零变更，acted 仍为 false，要求重选', () => {
    const g = flipPhaseGame();
    // 忽略 swap.attempts（它本身就是要记录非法尝试的公开日志），其余状态必须零变更
    const gameplay = (s: GameState) => {
      const { swap, ...rest } = s;
      return JSON.stringify({ ...rest, swap: { acted: swap.acted } });
    };
    const before = gameplay(g);
    const r = applySwap(g, 0, 1, 2); // 1明 2暗
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.swap.acted[0]).toBe(false);
    expect(r.state.turn).toBe(0); // 行动权不转移
    expect(gameplay(r.state)).toBe(before);
    // 非法记录（公开，只含牌号；不含明暗）
    const rej = r.logHints.find((h) => h.kind === 'swapRejected');
    expect(rej).toBeTruthy();
    expect(JSON.stringify(rej)).not.toMatch(/faceUp|"value"/);
    expect(r.state.swap.attempts.length).toBe(1);
    expect(r.state.swap.attempts[0].valid).toBe(false);
  });

  it('选择同一牌位被拒（非法记录）', () => {
    const g = flipPhaseGame();
    const r = applySwap(g, 0, 2, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.logHints.some((h) => h.kind === 'swapRejected')).toBe(true);
    expect(r.state.swap.acted[0]).toBe(false);
  });

  it('非本人回合易位被拒', () => {
    const g = flipPhaseGame();
    expect(expectFail(applySwap(g, 1, 1, 2))).toBe('NOT_YOUR_TURN');
  });

  it('双方完成后进入下注阶段（先手先行动）', () => {
    const g = flipPhaseGame();
    const r1 = expectOk(applySwap(g, 0, 2, 3));
    expect(r1.phase).toBe('swap');
    // 后手（B）手上是 2明 3明，可以易位
    const r2 = applySwap(r1, 1, 2, 3);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.state.phase).toBe('bet');
    expect(r2.state.turn).toBe(r2.state.first);
  });
});

describe('11.4 底注', () => {
  it('ante === ceil(明牌总数 / 2)', () => {
    const cases: [string, string, number][] = [
      ['dddd', 'dddd', 0],
      ['uddd', 'dddd', 1],
      ['uudd', 'dddd', 1],
      ['uudd', 'uddd', 2],
      ['uuuu', 'dddd', 2],
      ['uuud', 'uddd', 2],
      ['uuuu', 'uudd', 3],
      ['uuuu', 'uuud', 4],
      ['uuuu', 'uuuu', 4],
    ];
    for (const [a, b, want] of cases) {
      const g = makeGame();
      setBoard(g, 0, a);
      setBoard(g, 1, b);
      expect(countFaceUp(g)).toBe(a.split('').filter((c) => c === 'u').length + b.split('').filter((c) => c === 'u').length);
      expect(calculateAnte(g)).toBe(want);
      expect(calculateAnte(g)).toBe(ceilDiv(countFaceUp(g), 2));
    }
  });

  it('明牌总数为 0 → ante = 0，双方均可支付', () => {
    const g = makeGame();
    setBoard(g, 0, 'dddd');
    setBoard(g, 1, 'dddd');
    const s = expectOk(beginBetPhase(g));
    expect(s.bet.ante).toBe(0);
    expect(s.phase).toBe('bet');
    expect(s.players.map((p) => p.chips)).toEqual([64, 64]);
  });

  it('先手无力支付底注 → 后手获胜', () => {
    const g = makeGame({ first: 0 });
    setBoard(g, 0, 'uuuu');
    setBoard(g, 1, 'uuuu');
    g.players[0].chips = 1; // ante = 4
    const s = expectOk(beginBetPhase(g));
    expect(s.phase).toBe('gameOver');
    expect(s.gameOver?.winner).toBe(1);
    expect(s.gameOver?.reason).toBe('insolventAnte');
  });

  it('先手能付、后手不能 → 先手获胜', () => {
    const g = makeGame({ first: 0 });
    setBoard(g, 0, 'uuuu');
    setBoard(g, 1, 'uuuu');
    g.players[1].chips = 1;
    const s = expectOk(beginBetPhase(g));
    expect(s.phase).toBe('gameOver');
    expect(s.gameOver?.winner).toBe(0);
  });

  it('双方都不能付 → 先手先检查，后手获胜', () => {
    const g = makeGame({ first: 1 }); // 先手是 B
    setBoard(g, 0, 'uuuu');
    setBoard(g, 1, 'uuuu');
    g.players[0].chips = 0;
    g.players[1].chips = 0;
    const s = expectOk(beginBetPhase(g));
    expect(s.gameOver?.winner).toBe(0); // 先手是 seat 1（B）输 → winner = 0
  });

  it('底注立即从双方筹码扣除，pot = 2 * ante', () => {
    const g = makeGame();
    setBoard(g, 0, 'uudd');
    setBoard(g, 1, 'uudd'); // 4 明 → ante = 2
    const s = expectOk(beginBetPhase(g));
    expect(s.bet.ante).toBe(2);
    expect(s.bet.bets).toEqual([2, 2]);
    expect(s.bet.pot).toBe(4);
    expect(s.players.map((p) => p.chips)).toEqual([62, 62]);
  });

  it('callBase 为底注扣除后的快照；limitBase = floor(对手筹码 / 2)', () => {
    const g = makeGame();
    setBoard(g, 0, 'uudd');
    setBoard(g, 1, 'uudd'); // ante 2 → 各剩 62
    const s = expectOk(beginBetPhase(g));
    expect(s.bet.callBase).toEqual([62, 62]);
    expect(s.bet.limitBase).toEqual([31, 31]);
  });

  it('上限基数以「本轮下注开始时」对手筹码为准（已锁定口径）', () => {
    const g = makeGame();
    setBoard(g, 0, 'uudd');
    setBoard(g, 1, 'uudd');
    g.players[0].chips = 40;
    g.players[1].chips = 20;
    const s = expectOk(beginBetPhase(g));
    // ante = 2 → callBase = [38, 18]
    expect(s.bet.callBase).toEqual([38, 18]);
    // seat0 上限 = floor(18/2) = 9；seat1 上限 = floor(38/2) = 19
    expect(s.bet.limitBase).toEqual([9, 19]);
  });
});

describe('11.9 轮次与结束（基础）', () => {
  it('first = (initialFirst + round - 1) % 2', () => {
    expect(firstOf(0, 1)).toBe(0);
    expect(firstOf(0, 2)).toBe(1);
    expect(firstOf(0, 3)).toBe(0);
    expect(firstOf(1, 1)).toBe(1);
    expect(firstOf(1, 2)).toBe(0);
  });

  it('startRound 交换先后手、清空本轮临时状态、保留牌与筹码', () => {
    const g = makeGame({ first: 0 });
    setBoard(g, 0, 'dudd');
    g.players[0].chips = 50;
    const s = startRound(g);
    expect(s.round).toBe(2);
    expect(s.first).toBe(1);
    expect(s.second).toBe(0);
    expect(s.turn).toBe(1);
    expect(s.phase).toBe('flip');
    expect(s.flip.acted).toEqual([false, false]);
    expect(s.swap.acted).toEqual([false, false]);
    expect(s.bet.pot).toBe(0);
    expect(boardLayout(s, 0)).toBe('dudd'); // 牌局跨轮保留
    expect(s.players[0].chips).toBe(50);
    expect(s.swap.attempts).toEqual(g.swap.attempts);
  });

  it('startRound 不修改入参', () => {
    const g = makeGame({ first: 0 });
    const snap = JSON.stringify(g);
    startRound(g);
    expect(JSON.stringify(g)).toBe(snap);
  });
});
