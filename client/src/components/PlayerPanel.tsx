interface PlayerPanelProps {
  name: string;
  chips: number;
  bet: number;
  connected: boolean;
  isTurn: boolean;
  isYou: boolean;
  ready?: boolean;
  testId?: string;
}

/** 玩家信息面板（不渲染任何牌信息） */
export function PlayerPanel({
  name,
  chips,
  bet,
  connected,
  isTurn,
  isYou,
  ready,
  testId,
}: PlayerPanelProps) {
  return (
    <div className={`card player ${isTurn ? 'turn' : ''}`} data-testid={testId}>
      <span className="name">
        {name}
        {isYou && <span className="muted small">（你）</span>}
      </span>
      {ready !== undefined && (
        <span className="row small muted" style={{ gap: 5 }}>
          <span className={`ready-dot ${ready ? 'on' : ''}`} />
          {ready ? '已准备' : '未准备'}
        </span>
      )}
      <div className="spacer" />
      <span className="chips" data-testid={testId ? `${testId}-chips` : undefined}>
        {chips} 筹码
      </span>
      <span className="tag" data-testid={testId ? `${testId}-bet` : undefined}>
        本轮投入 {bet}
      </span>
      {isTurn && <span className="tag on">行动中</span>}
      {!connected && <span className="tag err">离线</span>}
    </div>
  );
}
