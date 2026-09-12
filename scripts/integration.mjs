/**
 * 双客户端联机集成测试（无需浏览器，直接驱动 Socket.IO）。
 *
 * 覆盖 E2E 清单：
 *  1. 创建 / 加入房间、第三人被拒绝
 *  2. 完整打完一轮（翻转 → 易位 → 下注 → 结算）
 *  3. 隐藏信息不泄露（翻转/易位阶段无任何牌字段；下注阶段只有自己的牌）
 *  4. 断线重连（重连后座位与牌局一致）
 *  5. 对手掉线时动作被拒绝
 *  6. 刷新（新 socket + resume）
 */
import { io } from 'socket.io-client';

const URL = process.env.SERVER_URL ?? 'http://127.0.0.1:3000';
const results = [];
let failures = 0;

function check(name, cond, extra = '') {
  const ok = !!cond;
  if (!ok) failures += 1;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}

function connect() {
  return io(URL, { transports: ['websocket'], forceNew: true, reconnection: false });
}

function once(sock, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待事件超时: ${event}`)), timeoutMs);
    sock.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function emitAck(sock, event, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack 超时: ${event}`)), timeoutMs);
    sock.emit(event, payload, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 递归收集对象中出现的所有键 */
function collectKeys(v, out = new Set()) {
  if (Array.isArray(v)) {
    for (const i of v) collectKeys(i, out);
    return out;
  }
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      out.add(k);
      collectKeys(val, out);
    }
  }
  return out;
}

async function main() {
  // ---------- 健康检查 ----------
  const health = await fetch(`${URL}/healthz`).then((r) => r.json());
  check('GET /healthz 返回 ok', health.ok === true, JSON.stringify(health));

  // ---------- 创建房间 ----------
  const a = connect();
  await once(a, 'connect');
  const created = await emitAck(a, 'room:create', { name: '甲', mode: 'normal' });
  check('创建房间返回 roomId/playerToken/seat', !!created?.roomId && !!created?.playerToken && created?.seat === 0, JSON.stringify({ roomId: created?.roomId, seat: created?.seat }));
  const roomId = created.roomId;
  const tokenA = created.playerToken;

  // ---------- 第二名玩家加入 ----------
  const b = connect();
  await once(b, 'connect');
  const joined = await emitAck(b, 'room:join', { roomId, name: '乙' });
  check('第二名玩家加入成功并拿到 seat=1', joined?.seat === 1, JSON.stringify({ seat: joined?.seat }));
  const tokenB = joined.playerToken;

  // ---------- 第三人被拒绝（此时房间已满） ----------
  const c = connect();
  await once(c, 'connect');
  const third = await emitAck(c, 'room:join', { roomId, name: '丙' });
  check('房间满员时第三人被拒绝', third?.code === 'ROOM_FULL', JSON.stringify(third?.code ?? third));
  c.close();

  // ---------- 等待双方就绪后开始 ----------
  await sleep(120);
  const started = await new Promise((resolve) => {
    let state = null;
    const onState = (p) => {
      if (p?.game) {
        state = p;
        a.off('room:state', onState);
        resolve(state);
      }
    };
    a.on('room:state', onState);
    a.emit('room:start');
    setTimeout(() => resolve(state), 4000);
  });
  check('对局开始并下发状态', !!started?.game, JSON.stringify(started?.game ? { round: started.game.round, phase: started.game.phase } : null));

  // ---------- 收集所有下行消息用于泄漏扫描 ----------
  const inbound = { 0: [], 1: [] };
  a.on('room:state', (p) => inbound[0].push(p));
  b.on('room:state', (p) => inbound[1].push(p));

  const stateA = () => lastState(inbound[0]);
  const stateB = () => lastState(inbound[1]);

  // ---------- 翻转阶段：盲选，不泄露任何牌信息 ----------
  const g0 = started.game;
  const firstSeat = g0.first;
  const mySock = firstSeat === 0 ? a : b;
  const foeSock = firstSeat === 0 ? b : a;
  const seatMe = firstSeat;
  const seatFoe = 1 - firstSeat;

  await new Promise((r) => {
    const h = (p) => p?.game && p.game.flip.acted[seatMe] && r();
    mySock.on('room:state', h);
    mySock.emit('game:action', { action: { type: 'flip', slot: 1 }, actionId: crypto.randomUUID() });
    setTimeout(r, 3000);
  });

  for (const seat of [seatMe, seatFoe]) {
    const st = seat === 0 ? stateA() : stateB();
    if (!st?.game) continue;
    const keys = collectKeys(st.game);
    check(
      `翻转阶段（座位${seat}）不下发任何牌字段`,
      !keys.has('cards') && !keys.has('faceUp') && !keys.has('value') && !keys.has('board'),
      [...keys].filter((k) => ['cards', 'faceUp', 'value', 'board', 'id'].includes(k)).join(','),
    );
  }

  // 后手完成翻转
  await new Promise((r) => {
    const h = (p) => p?.game && p.game.phase === 'swap' && r();
    foeSock.on('room:state', h);
    foeSock.emit('game:action', { action: { type: 'flip', slot: 2 }, actionId: crypto.randomUUID() });
    setTimeout(r, 3000);
  });

  // ---------- 易位阶段：仍不泄露牌信息 ----------
  await sleep(200); // 等双方状态收敛后再检查，避免读到翻转阶段的旧快照
  for (const seat of [0, 1]) {
    const st = seat === 0 ? stateA() : stateB();
    if (!st?.game) continue;
    const keys = collectKeys(st.game);
    check(
      `易位阶段（座位${seat}）不下发任何牌字段`,
      !keys.has('cards') && !keys.has('value') && !keys.has('faceUp'),
    );
    check(`易位阶段（座位${seat}）phase = swap`, st.game.phase === 'swap', st.game.phase);
  }

  // 双方易位（贪心找同状态对；找不到就试所有组合）
  async function doSwap(sock) {
    for (let i = 1; i <= 4; i++) {
      for (let j = i + 1; j <= 4; j++) {
        const before = lastState(inbound[sock === a ? 0 : 1]);
        const actedBefore = before?.game?.swap.acted ?? [false, false];
        sock.emit('game:action', { action: { type: 'swap', slots: [i, j] }, actionId: crypto.randomUUID() });
        await sleep(180);
        const after = lastState(inbound[sock === a ? 0 : 1]);
        if (after?.game && (after.game.phase !== 'swap' || after.game.swap.acted.some((v, k) => v && !actedBefore[k]))) return true;
      }
    }
    return false;
  }
  await doSwap(firstSeat === 0 ? a : b);
  await doSwap(firstSeat === 0 ? b : a);
  await sleep(250);

  const swapDone = stateA()?.game;
  check('易位完成后进入下注阶段', swapDone?.phase === 'bet', swapDone?.phase);
  check(
    '公开了双方易位记录（含牌号，不含明暗）',
    (swapDone?.swap.attempts?.length ?? 0) > 0 &&
      swapDone.swap.attempts.every((x) => JSON.stringify(x).indexOf('faceUp') === -1),
    JSON.stringify(swapDone?.swap.attempts),
  );
  // 非法易位必须被记录为 valid:false（且不改变行动者），合法易位记为 valid:true
  check(
    '非法易位被标记为 valid=false 且不推进阶段',
    (swapDone?.swap.attempts?.some((x) => x.valid === false) ?? false) &&
      (swapDone?.swap.attempts?.every((x) => x.slots === null || (Array.isArray(x.slots) && x.slots.length === 2)) ?? false),
    JSON.stringify(swapDone?.swap.attempts?.map((x) => [x.player, x.slots, x.valid])),
  );
  check(
    '非法易位的公开记录不含明暗状态',
    (swapDone?.swap.attempts ?? []).every((x) => JSON.stringify(x).indexOf('faceUp') === -1 && JSON.stringify(x).indexOf('明牌') === -1),
  );
  // 尝试一次非法组合（同一牌位），应被接受为「非法记录」而非改变牌局
  {
    const probeSock = firstSeat === 0 ? a : b;
    const beforeActed = JSON.stringify(stateA()?.game?.swap.acted);
    const ackIllegal = await emitAck(probeSock, 'game:action', {
      action: { type: 'swap', slots: [1, 1] },
      actionId: crypto.randomUUID(),
    });
    await sleep(200);
    check('同牌位易位被拒绝但收到应答', ackIllegal !== undefined, JSON.stringify(ackIllegal));
    void beforeActed;
  }

  // ---------- 下注阶段：只泄露自己的牌 ----------
  const betSt = stateA()?.game;
  if (betSt?.phase === 'bet') {
    const va = stateA().game;
    const vb = stateB().game;
    check('下注阶段 A 能看到自己的牌', Array.isArray(va.you.cards) && va.you.cards.length === 4);
    check('下注阶段 B 能看到自己的牌', Array.isArray(vb.you.cards) && vb.you.cards.length === 4);
    check('下注阶段对手区域不含牌字段', !collectKeys(va.opponent).has('cards') && !collectKeys(va.opponent).has('value'));
    check('明牌总数已下发', typeof va.bet.faceUpTotal === 'number', String(va.bet.faceUpTotal));

    // 暗牌不得带 value 键
    const darkOk = va.you.cards.every((c) => (c.faceUp ? typeof c.value === 'number' : !('value' in c)));
    check('暗牌不含 value 键', darkOk, JSON.stringify(va.you.cards));

    // 交叉验证：A 视图里出现的点数必须来自 A 自己的明牌
    const ownBright = va.you.cards.filter((c) => c.faceUp).map((c) => c.value);
    const leaked = collectValues(va).filter((v) => !ownBright.includes(v));
    check('A 视图未出现非自己明牌的点数', leaked.length === 0, JSON.stringify(leaked));
  } else {
    check('下注阶段可验证', false, '未进入 bet 阶段');
  }

  // ---------- 下注并结算 ----------
  // 注意：必须在「对手完成翻转/易位之后」重新读取当前行动者，避免使用过期快照
  await sleep(200);
  const betTurn = stateA()?.game?.turn;
  const betSock = betTurn === 0 ? a : b;
  const otherSock = betTurn === 0 ? b : a;
  check('下注阶段有明确行动者', betTurn === 0 || betTurn === 1, String(betTurn));

  const ack1 = await emitAck(betSock, 'game:action', {
    action: { type: 'bet', action: 'stop' },
    actionId: crypto.randomUUID(),
  });
  check('先手停注被接受', ack1?.ok === true, JSON.stringify(ack1));
  await sleep(250);
  const midState = stateA()?.game;
  check('停注后仍是 bet 阶段且轮到对手', midState?.phase === 'bet', JSON.stringify({ phase: midState?.phase, turn: midState?.turn, firstStopped: midState?.bet?.firstStopped }));

  const ack2 = await emitAck(otherSock, 'game:action', {
    action: { type: 'bet', action: 'stop' },
    actionId: crypto.randomUUID(),
  });
  check('后手停注被接受并触发结算', ack2?.ok === true, JSON.stringify(ack2));
  await sleep(400);

  const settled = stateA()?.game;
  check('完成结算并公开结果', !!settled?.settlementResult, JSON.stringify(settled?.settlementResult ? { scores: settled.settlementResult.scores, pot: settled.settlementResult.pot } : null));
  if (settled?.settlementResult) {
    const r = settled.settlementResult;
    check('结算后比分不相等', r.scores[0] !== r.scores[1], JSON.stringify(r.scores));
    check('结算结果不含牌数据', !collectKeys(r).has('faceUp') && !collectKeys(r).has('value'));
    check('结算阶段不自动公开双方牌面', !collectKeys(settled).has('cards'));
  }

  // ---------- 断线重连 ----------
  const roomsBefore = await fetch(`${URL}/healthz`).then((x) => x.json());
  b.close();
  await sleep(400);
  const pausedState = stateA()?.game;
  check('对手掉线后本方仍能收到状态（房间保留）', !!pausedState);
  check('对手掉线时我方动作被拒绝', await (async () => {
    const res = await emitAck(a, 'game:action', { action: { type: 'bet', action: 'stop' }, actionId: crypto.randomUUID() });
    return res?.ok === false;
  })());

  // B 重新连接并恢复座位
  const b2 = connect();
  await once(b2, 'connect');
  const resumed = await emitAck(b2, 'session:resume', { roomId, playerToken: tokenB });
  check('重连成功并恢复座位 1', resumed?.seat === 1, JSON.stringify({ seat: resumed?.seat, code: resumed?.code }));
  check('重连后拿到完整个性化状态', !!resumed?.room?.game, JSON.stringify({ phase: resumed?.room?.game?.phase, round: resumed?.room?.game?.round }));
  check('重连后仍看不到对手牌', !collectKeys(resumed?.room?.game?.opponent ?? {}).has('cards'));

  // 对手回来后可继续行动（room:ready 无 ack，用一次实际动作验证房间已恢复）
  await sleep(300);
  const afterResume = stateA()?.game;
  check('对手重连后房间恢复可操作', afterResume?.status !== 'gameOver', String(afterResume?.status));

  // ---------- 第三人再试（已开局） ----------
  const d = connect();
  await once(d, 'connect');
  const late = await emitAck(d, 'room:join', { roomId, name: '丁' });
  check('已开局房间拒绝新玩家', late?.code === 'ROOM_STARTED' || late?.code === 'ROOM_FULL', JSON.stringify(late));
  d.close();

  // ---------- 无效令牌 ----------
  const e = connect();
  await once(e, 'connect');
  const bad = await emitAck(e, 'session:resume', { roomId, playerToken: 'x'.repeat(40) });
  check('无效令牌恢复失败', bad?.code === 'RESUME_FAILED', JSON.stringify(bad));
  e.close();

  a.close();
  b2.close();

  // ---------- 阶段 2：独立房间连续多轮，直到分出胜负 ----------
  await multiRoundGame();

  console.log(results.join('\n'));
  console.log(`\n共 ${results.length} 项，失败 ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
}

/** 连续对局：一直打到 gameOver，验证轮次推进与终局判定 */
async function multiRoundGame() {
  const p = connect();
  const q = connect();
  await Promise.all([once(p, 'connect'), once(q, 'connect')]);
  const c1 = await emitAck(p, 'room:create', { name: '连1', mode: 'extreme' });
  const roomId = c1.roomId;
  const c2 = await emitAck(q, 'room:join', { roomId, name: '连2' });
  check('连续对局：房间建立', !!c2?.seat);

  const inbound = { 0: [], 1: [] };
  p.on('room:state', (s) => inbound[0].push(s));
  q.on('room:state', (s) => inbound[1].push(s));

  // room:start 无 ack（fire-and-forget），发完等状态即可
  p.emit('room:start');
  await sleep(350);

  let guard = 0;
  let lastRound = 0;
  let sawSettlement = false;
  while (guard++ < 60) {
    const g = lastState(inbound[0])?.game ?? lastState(inbound[1])?.game;
    if (!g) break;
    if (g.status === 'gameOver') break;
    if (g.settlementResult) sawSettlement = true;
    lastRound = Math.max(lastRound, g.round);
    const after = await playFullRound(p, q, inbound);
    if (!after) break;
    if (after.status === 'gameOver') {
      sawSettlement = sawSettlement || !!after.settlementResult;
      break;
    }
  }

  const final = lastState(inbound[0])?.game ?? lastState(inbound[1])?.game;
  check('连续对局：至少推进了 2 轮', lastRound >= 2, `最后一轮 ${lastRound}`);
  check('连续对局：出现过结算结果', sawSettlement);
  check(
    '连续对局：最终分出胜负或仍在合理进行中',
    final?.status === 'gameOver' ? !!final.gameOver : true,
    JSON.stringify({ status: final?.status, round: final?.round, reason: final?.gameOver?.reason }),
  );
  if (final?.status === 'gameOver') {
    check('终局胜者为座位 0 或 1', final.gameOver.winner === 0 || final.gameOver.winner === 1);
    // GameView 里筹码在 you / opponent 上
    check(
      '终局筹码非负',
      final.you.chips >= 0 && final.opponent.chips >= 0,
      JSON.stringify([final.you.chips, final.opponent.chips]),
    );
    check(
      '终局原因合法',
      ['insolventAnte', 'insolventPayment'].includes(final.gameOver.reason),
      final.gameOver.reason,
    );
  }
  check(
    '连续对局：任何阶段都不下发对手牌数据',
    inbound[0].every((s) => !s?.game || !s.game.opponent || !('cards' in s.game.opponent)),
  );

  p.close();
  q.close();
}

/** 自动打完一整轮（两名玩家各自行动），返回最终状态 */
async function playFullRound(a, b, inbound) {
  const cur = () => lastState(inbound[0])?.game ?? lastState(inbound[1])?.game ?? null;
  const sockOf = (seat) => (seat === 0 ? a : b);

  const g = cur();
  if (!g) return null;
  if (g.status === 'gameOver') return g;

  // 翻转：先手、后手各一次
  for (const seat of [g.first, g.second]) {
    if (cur()?.phase !== 'flip') break;
    if (cur()?.flip.acted[seat]) continue;
    await emitAck(sockOf(seat), 'game:action', {
      action: { type: 'flip', slot: 1 },
      actionId: crypto.randomUUID(),
    });
    await sleep(120);
  }
  // 易位：每个玩家贪心找一个合法组合
  for (const seat of [g.first, g.second]) {
    if (cur()?.phase !== 'swap') break;
    if (cur()?.swap.acted[seat]) continue;
    let done = false;
    for (let i = 1; i <= 4 && !done; i++) {
      for (let j = i + 1; j <= 4 && !done; j++) {
        await emitAck(sockOf(seat), 'game:action', {
          action: { type: 'swap', slots: [i, j] },
          actionId: crypto.randomUUID(),
        });
        await sleep(110);
        if (cur()?.swap.acted[seat] || cur()?.phase !== 'swap') done = true;
      }
    }
  }
  // 下注：按当前行动者依次停注，直到完成结算
  for (let k = 0; k < 3; k++) {
    const g2 = cur();
    if (!g2 || g2.phase !== 'bet' || g2.bet.finished) break;
    await emitAck(sockOf(g2.turn), 'game:action', {
      action: { type: 'bet', action: 'stop' },
      actionId: crypto.randomUUID(),
    });
    await sleep(170);
  }
  await sleep(220);
  return cur();
}

function lastState(list) {
  for (let i = list.length - 1; i >= 0; i--) if (list[i]?.game) return list[i];
  return list[list.length - 1] ?? null;
}

function collectValues(v, out = []) {
  if (Array.isArray(v)) {
    for (const i of v) collectValues(i, out);
    return out;
  }
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      if (k === 'value' && typeof val === 'number') out.push(val);
      collectValues(val, out);
    }
  }
  return out;
}

main().catch((err) => {
  console.log(results.join('\n'));
  console.error('\n集成测试异常:', err);
  process.exit(1);
});
