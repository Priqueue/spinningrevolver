import { useEffect, useMemo, useState } from 'react';
import type { GameView, Seat, Slot } from '@zuolun/shared';
import { useStore } from '../store';
import { sendAction } from '../socket';
import { Board } from '../components/Board';
import { BetPanel } from '../components/BetPanel';
import { LogPanel } from '../components/LogPanel';
import { PlayerPanel } from '../components/PlayerPanel';
import { SettlementPanel } from '../components/SettlementPanel';

const PHASE_LABEL: Record<string, string> = {
  flip: '翻转',
  swap: '易位',
  bet: '下注',
  settle: '结算',
  gameOver: '已结束',
};

/**
 * 房间页：等待房间 + 游戏桌。
 * 所有动作都发给服务端裁决；本地只维护「选择」这类无副作用的 UI 状态。
 */
export function Room() {
  const { room, session } = useStore();
  if (!room || !session) return null;
  const started = room.game !== null;
  return (
    <div className="table">
      <RoomHeader />
      {started ? <GameTable /> : <WaitingRoom />}
    </div>
  );
}

/* ---------------- 房间头部 ---------------- */

function RoomHeader() {
  const { room, session, doLeave, connected, logs } = useStore();
  if (!room || !session) return null;
  const statusText =
    room.room.status === 'waiting'
      ? '等待玩家'
      : room.room.status === 'playing'
        ? '对局进行中'
        : room.room.status === 'paused'
          ? '等待对手重连（已暂停）'
          : '对局已结束';

  return (
    <div className="card">
      <div className="row wrap">
        <div>
          <div className="muted small">房间号</div>
          <div className="roomcode" data-testid="room-code">
            {room.room.roomId}
          </div>
        </div>
        <div className="spacer" />
        <div className="row wrap" style={{ gap: 8 }}>
          <span className="tag">{room.room.mode === 'normal' ? '正常模式 64' : '极限模式 16'}</span>
          <span className={`tag ${room.room.status === 'paused' ? 'warn' : room.room.status === 'gameOver' ? 'err' : 'on'}`}>
            {statusText}
          </span>
          <span className={`tag ${connected ? '' : 'err'}`}>
            {connected ? '连接正常' : '连接中断'}
          </span>
          <button className="small ghost danger" onClick={doLeave} data-testid="leave-room">
            退出房间
          </button>
        </div>
      </div>
      {room.room.awaitingReconnect && (
        <div className="banner offline" style={{ marginTop: 8 }}>
          有玩家离线：对手掉线时对局暂停，不自动代打；10 分钟内重连可继续。
        </div>
      )}
      <LogPanel logs={logs} />
    </div>
  );
}

/* ---------------- 等待房间 ---------------- */

function WaitingRoom() {
  const { room, session, doReady, doStart } = useStore();
  if (!room || !session) return null;
  const me = room.players.find((p) => p.seat === session.seat);
  const foe = room.players.find((p) => p.seat !== session.seat);
  const canStart = room.players.length === 2 && room.players.every((p) => p.ready) && room.room.status === 'waiting';

  return (
    <div className="card">
      <h2>等待对手加入</h2>
      <p className="muted small">
        把房间号 <b className="mono" style={{ color: 'var(--accent-2)' }}>{room.room.roomId}</b> 发给朋友，他输入后即可入座。
      </p>

      <div className="row wrap" style={{ gap: 10, marginTop: 8 }}>
        {me && (
          <PlayerPanel
            testId="me-panel"
            name={me.name}
            chips={me.chips}
            bet={0}
            connected={me.connected}
            isTurn={false}
            isYou
            ready={me.ready}
          />
        )}
        {foe ? (
          <PlayerPanel
            testId="foe-panel"
            name={foe.name}
            chips={foe.chips}
            bet={0}
            connected={foe.connected}
            isTurn={false}
            isYou={false}
            ready={foe.ready}
          />
        ) : (
          <div className="card muted">空座位：等待第二位玩家…</div>
        )}
      </div>

      <div className="actions" style={{ marginTop: 12 }}>
        <button
          className={me?.ready ? 'ghost' : 'primary'}
          onClick={() => doReady(!me?.ready)}
          data-testid="toggle-ready"
        >
          {me?.ready ? '取消准备' : '我准备好了'}
        </button>
        <button className="primary" disabled={!canStart} onClick={doStart} data-testid="start-game">
          {canStart ? '开始对局' : '双方准备后可开始'}
        </button>
      </div>
    </div>
  );
}

/* ---------------- 游戏桌 ---------------- */

function GameTable() {
  const { room, session, doRematch } = useStore();
  const [flipPick, setFlipPick] = useState<Slot | null>(null);
  const [swapPicks, setSwapPicks] = useState<Slot[]>([]);

  const game = room?.game ?? null;
  const phase = game?.phase ?? 'flip';
  const turn = game?.turn ?? 0;
  const betFinished = game?.bet.finished ?? false;

  // 阶段/行动者变化时清空本地选择，避免误用上一次的选择
  useEffect(() => {
    setFlipPick(null);
    setSwapPicks([]);
  }, [phase, turn, game?.round, betFinished]);

  const mySeat: Seat = session?.seat ?? 0;
  const isMyTurn = game !== null && game.turn === mySeat && game.status !== 'gameOver' && !betFinished;

  const myName = game?.you.name ?? '';
  const opponentName = game?.opponent.name ?? '对手';

  const phaseSteps = useMemo(
    () => [
      { key: 'flip', label: '翻转' },
      { key: 'swap', label: '易位' },
      { key: 'bet', label: '下注' },
      { key: 'settle', label: '结算' },
    ],
    [],
  );

  if (!game) return null;

  async function act(action: Parameters<typeof sendAction>[0]) {
    const res = await sendAction(action);
    if (!res.ok && res.code) {
      // 服务端已裁决失败，提示后由玩家重选
      console.warn('action rejected:', res.code);
    }
  }

  function pickFlip(slot: Slot) {
    if (!isMyTurn || phase !== 'flip') return;
    setFlipPick(slot);
    void act({ type: 'flip', slot });
  }

  function pickSwap(slot: Slot) {
    if (!isMyTurn || phase !== 'swap') return;
    const next = swapPicks.includes(slot) ? swapPicks.filter((s) => s !== slot) : [...swapPicks, slot];
    if (next.length < 2) {
      setSwapPicks(next);
      return;
    }
    const pair = [next[0], next[1]] as [Slot, Slot];
    setSwapPicks([]);
    void act({ type: 'swap', slots: pair });
  }

  const isBlind = phase === 'flip' || phase === 'swap';

  return (
    <>
      {/* 阶段指示 */}
      <div className="card phase-bar">
        {phaseSteps.map((s) => {
          const order = phaseSteps.findIndex((x) => x.key === phase);
          const index = phaseSteps.findIndex((x) => x.key === s.key);
          const cls = index === order ? 'active' : index < order ? 'done' : '';
          return (
            <span key={s.key} className={`phase-chip ${cls}`}>
              {s.label}
            </span>
          );
        })}
        <div className="spacer" />
        <span className="muted small" data-testid="round-indicator">
          第 {game.round} 轮 · 先手：{game.first === mySeat ? '你' : '对手'}
        </span>
        <span className={`tag ${isMyTurn ? 'on' : ''}`} data-testid="turn-indicator">
          {game.status === 'gameOver' ? '对局结束' : isMyTurn ? '轮到你了' : '等待对手'}
        </span>
      </div>

      {/* 对手区域：永不渲染对手的牌 */}
      <div className="card">
        <PlayerPanel
          testId="foe-panel"
          name={opponentName}
          chips={game.opponent.chips}
          bet={game.opponent.bet}
          connected={game.opponent.connected}
          isTurn={game.turn !== mySeat && game.status !== 'gameOver'}
          isYou={false}
        />
        <div style={{ marginTop: 10 }}>
          <h3>对手牌区（不可见）</h3>
          <Board blind selected={[]} testId="foe-slot" />
        </div>
      </div>

      {/* 关键信息 */}
      <div className="card">
        <div className="meta-grid">
          <div className="meta">
            <div className="k">对手明牌数之和</div>
            <div className="v" data-testid="faceup-total">
              {game.bet.faceUpTotal === null ? '—' : game.bet.faceUpTotal}
            </div>
            <div className="muted small">进入下注阶段后公开</div>
          </div>
          <div className="meta">
            <div className="k">底注</div>
            <div className="v" data-testid="ante-value">
              {game.bet.ante}
            </div>
          </div>
          <div className="meta">
            <div className="k">场上总注 N</div>
            <div className="v" data-testid="pot-value">
              {game.bet.pot}
            </div>
          </div>
          <div className="meta">
            <div className="k">你的本轮投入</div>
            <div className="v">{game.you.bet}</div>
          </div>
        </div>
      </div>

      {/* 自己的牌区 */}
      <div className="card">
        <div className="row wrap">
          <h3 style={{ margin: 0 }}>
            你的牌区
            {isBlind && <span className="muted small">（{PHASE_LABEL[phase]}阶段：盲选，不显示任何牌信息）</span>}
          </h3>
          <div className="spacer" />
          {phase === 'flip' && isMyTurn && <span className="muted small">点击牌位完成翻转</span>}
          {phase === 'swap' && isMyTurn && (
            <span className="muted small" data-testid="swap-hint">
              已选 {swapPicks.join('、') || '无'}（选两个同明暗状态的牌位）
            </span>
          )}
        </div>

        <div style={{ marginTop: 10 }}>
          {isBlind ? (
            <Board
              blind
              selectable={isMyTurn && (phase === 'flip' || phase === 'swap')}
              selected={phase === 'flip' ? (flipPick === null ? [] : [flipPick]) : swapPicks}
              onPick={phase === 'flip' ? pickFlip : pickSwap}
              testId="my-slot"
            />
          ) : (
            <Board cards={game.you.cards} selected={[]} testId="my-slot" />
          )}
        </div>
      </div>

      {/* 操作区 */}
      {phase === 'bet' && (
        <BetPanel
          game={game}
          isMyTurn={isMyTurn}
          onCall={() => void act({ type: 'bet', action: 'call' })}
          onRaise={(amount) => void act({ type: 'bet', action: 'raise', amount })}
          onStop={() => void act({ type: 'bet', action: 'stop' })}
        />
      )}

      {phase !== 'bet' && phase !== 'gameOver' && (
        <div className="card">
          <div className="row wrap">
            <span className="muted small">
              {phase === 'flip'
                ? '翻转阶段：系统会先比较双方同一牌位的明暗状态，同状态翻自己的牌，异状态与对手交换。你无法得知对手选了哪个牌位。'
                : '易位阶段：只能交换自己牌堆中明暗状态相同的两张牌；非法组合会被拒绝并需重选。'}
            </span>
            <div className="spacer" />
            <span className="tag">
              你 {game.flip.acted[mySeat] ? '已' : '未'}
              完成翻转
            </span>
            <span className="tag">
              对手 {game.flip.acted[mySeat === 0 ? 1 : 0] ? '已' : '未'}
              完成翻转
            </span>
          </div>
        </div>
      )}

      {/* 结算：本阶段结算，或新一轮开始时展示上一轮结果 */}
      {(phase === 'settle' || phase === 'gameOver' || game.settlementResult) && (
        <SettlementPanel game={game} mySeat={mySeat} myName={myName} opponentName={opponentName} />
      )}

      {/* 结束 */}
      {game.status === 'gameOver' && game.gameOver && (
        <div className="card">
          <div className="row wrap">
            <h2 style={{ margin: 0 }} data-testid="game-over">
              对局结束：
              {game.gameOver.winner === mySeat ? '你获胜！' : '你告负'}
            </h2>
            <div className="spacer" />
            <span className="muted small">
              结束原因：
              {game.gameOver.reason === 'insolventAnte'
                ? '无力支付底注'
                : game.gameOver.reason === 'insolventPayment'
                  ? '赔付时筹码不足'
                  : '对手离开房间'}
            </span>
            <button className="primary" onClick={doRematch} data-testid="rematch">
              再来一局
            </button>
          </div>
        </div>
      )}
    </>
  );
}
