import { useState } from 'react';
import type { GameView } from '@zuolun/shared';

interface BetPanelProps {
  game: GameView;
  isMyTurn: boolean;
  onCall: () => void;
  onRaise: (amount: number) => void;
  onStop: () => void;
}

/**
 * 下注操作面板：跟注 / 加注 / 停注。
 * 上限提示来自服务端下发的 you.betLimit 与 you.betRemaining。
 */
export function BetPanel({ game, isMyTurn, onCall, onRaise, onStop }: BetPanelProps) {
  const [raiseAmount, setRaiseAmount] = useState('');
  const remaining = game.you.betRemaining;
  const canCall = isMyTurn && remaining >= 2;
  const parsed = Number.parseInt(raiseAmount, 10);
  const raiseValid = Number.isInteger(parsed) && parsed > 0 && parsed <= remaining;

  return (
    <div className="card">
      <div className="row wrap" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>下注</h3>
        <div className="spacer" />
        <span className="muted small">
          本轮上限 {game.you.betLimit}，剩余可投 <b style={{ color: 'var(--warn)' }}>{remaining}</b>
        </span>
      </div>

      <div className="actions">
        <button
          className="primary"
          disabled={!canCall}
          onClick={onCall}
          data-testid="bet-call"
          title={remaining < 2 ? '剩余额度不足，无法跟注' : '跟注 2 枚'}
        >
          跟注 2
        </button>

        <div className="raise-box">
          <input
            type="number"
            min={1}
            max={Math.max(0, remaining)}
            placeholder="加注数量"
            value={raiseAmount}
            disabled={!isMyTurn || remaining < 1}
            onChange={(e) => setRaiseAmount(e.target.value)}
            data-testid="bet-raise-input"
          />
          <button
            disabled={!isMyTurn || !raiseValid}
            onClick={() => {
              if (raiseValid) {
                onRaise(parsed);
                setRaiseAmount('');
              }
            }}
            data-testid="bet-raise"
          >
            加注
          </button>
        </div>

        <button disabled={!isMyTurn} onClick={onStop} data-testid="bet-stop">
          停注
        </button>
      </div>

      {!isMyTurn && (
        <p className="muted small" style={{ marginBottom: 0 }}>
          等待对手操作…
        </p>
      )}
    </div>
  );
}
