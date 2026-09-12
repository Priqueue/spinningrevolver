import { useStore } from './store';
import { Lobby } from './pages/Lobby';
import { Room } from './pages/Room';

/**
 * 顶层路由：无会话 → 大厅；有会话 → 房间/牌桌。
 */
export function App() {
  const { session, room, error, toast, connected, everConnected } = useStore();

  const showRoom = session !== null && room !== null;

  return (
    <div className="app">
      <header className="row" style={{ marginBottom: 4 }}>
        <h1>翻转左轮</h1>
        <div className="spacer" />
        <span className={`tag ${connected ? 'on' : 'err'}`}>{connected ? '已连接' : '未连接'}</span>
      </header>

      {!connected && (
        <div className={`banner ${everConnected ? 'offline' : 'connecting'}`} style={{ marginBottom: 10 }}>
          <span>
            {everConnected
              ? '与服务器的连接已断开，正在自动重连…（刷新页面也会自动回到座位）'
              : '正在连接服务器…'}
          </span>
        </div>
      )}

      {error && (
        <div className="alert error" style={{ marginBottom: 10 }}>
          {error}
        </div>
      )}

      {showRoom ? <Room /> : <Lobby />}

      <footer>
        服务端权威 · 翻转与易位阶段不传输任何牌信息 · 断线重连保留 10 分钟
      </footer>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
