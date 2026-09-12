import type { LogEntry } from '@zuolun/shared';

interface LogPanelProps {
  logs: LogEntry[];
}

function timeText(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 公开日志区。
 * 服务端只会下发 public 日志与本座位的 private 日志；
 * 翻转阶段不记录牌号，易位非法记录不包含明暗状态。
 */
export function LogPanel({ logs }: LogPanelProps) {
  const shown = logs.slice(-80);
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>对局日志</h3>
        <div className="spacer" />
        <span className="muted small">{shown.length} 条</span>
      </div>
      <div className="logs" data-testid="log-panel">
        {shown.length === 0 && <div className="muted small">暂无记录</div>}
        {shown.map((e) => (
          <div key={`${e.id}-${e.at}`} className={`log-line kind-${e.kind}`}>
            <span className="log-time">{timeText(e.at)}</span>
            {e.text}
          </div>
        ))}
      </div>
    </div>
  );
}
