import type { GameView, Seat } from '@zuolun/shared';

interface SettlementPanelProps {
  game: GameView;
  /** 当前玩家座位 */
  mySeat: Seat;
  /** 对手昵称 */
  opponentName: string;
  myName: string;
}

/**
 * 结算展示：比分、胜负、赔付、扣除。
 * 注意：结算不自动公开双方牌面，这里也不渲染任何牌数据。
 */
export function SettlementPanel({ game, mySeat, opponentName, myName }: SettlementPanelProps) {
  const r = game.settlementResult;
  if (!r) return null;

  const nameOf = (seat: Seat) => (seat === mySeat ? myName : opponentName);
  const iWon = r.winner === mySeat;

  return (
    <div className="card" data-testid="settlement">
      <div className="row wrap">
        <h3 style={{ margin: 0 }}>第 {game.round} 轮结算</h3>
        {r.tieBreak && <span className="tag warn">平局 · 已按规则加一判定</span>}
        <div className="spacer" />
        <span className={`tag ${iWon ? 'on' : 'err'}`} data-testid="settlement-verdict">
          {iWon ? '你赢了本轮' : '你输了本轮'}
        </span>
      </div>

      <div className="result-grid">
        <div className="meta">
          <div className="k">最终比分</div>
          <div className="v" data-testid="settlement-scores">
            {r.scores[0]} : {r.scores[1]}
          </div>
          <div className="muted small">
            {myName}(座位0) : {opponentName}(座位1)
          </div>
        </div>
        <div className="meta">
          <div className="k">场上总筹码 N</div>
          <div className="v" data-testid="settlement-pot">
            {r.pot}
          </div>
        </div>
        <div className="meta">
          <div className="k">败方支付</div>
          <div className="v">
            {r.actualPaid}
            {r.actualPaid < r.payment && <span className="muted small">（应付 {r.payment}，筹码不足）</span>}
          </div>
          <div className="muted small">{nameOf(r.loser)} 告负</div>
        </div>
        <div className="meta">
          <div className="k">胜方实收 / 被扣除</div>
          <div className="v">
            {r.winnerReceive} / {r.deduction}
          </div>
          <div className="muted small">{nameOf(r.winner)} 获胜（扣除部分移出游戏）</div>
        </div>
        <div className="meta">
          <div className="k">结算后筹码</div>
          <div className="v" data-testid="settlement-chips">
            {r.chipsAfter[0]} : {r.chipsAfter[1]}
          </div>
        </div>
      </div>
    </div>
  );
}
