import { useEffect, useState } from 'react';
import { useStore } from '../store';

const NAME_KEY = 'fanzhuan.zuolun.name';

export function Lobby() {
  const { doCreateRoom, doJoinRoom, resuming, resumeFailed } = useStore();
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'normal' | 'extreme'>('normal');
  const [roomId, setRoomId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(NAME_KEY);
      if (saved) setName(saved);
    } catch {
      /* ignore */
    }
  }, []);

  function persistName(value: string) {
    setName(value);
    try {
      localStorage.setItem(NAME_KEY, value);
    } catch {
      /* ignore */
    }
  }

  async function onCreate() {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    await doCreateRoom(n, mode);
    setBusy(false);
  }

  async function onJoin() {
    const n = name.trim();
    const r = roomId.trim().toUpperCase();
    if (!n || r.length !== 4) return;
    setBusy(true);
    await doJoinRoom(r, n);
    setBusy(false);
  }

  return (
    <div className="lobby">
      {resuming && <div className="alert info full">正在恢复上次的房间座位…</div>}
      {resumeFailed && <div className="alert error full">上次的房间已过期，请重新创建或加入。</div>}

      <section className="card full">
        <div className="field">
          <label htmlFor="nickname">昵称（最长 12 字）</label>
          <input
            id="nickname"
            value={name}
            maxLength={12}
            placeholder="例如：小李"
            onChange={(e) => persistName(e.target.value)}
          />
        </div>
      </section>

      <section className="card">
        <h2>创建房间</h2>
        <p className="muted small">创建后把 4 位房间号发给朋友，等他加入即可开局。</p>
        <div className="field">
          <label>筹码模式</label>
          <div className="mode-picker">
            <button
              type="button"
              className={mode === 'normal' ? 'active' : ''}
              onClick={() => setMode('normal')}
            >
              <div>正常</div>
              <div className="muted small">双方各 64 枚筹码</div>
            </button>
            <button
              type="button"
              className={mode === 'extreme' ? 'active' : ''}
              onClick={() => setMode('extreme')}
            >
              <div>极限</div>
              <div className="muted small">双方各 16 枚筹码</div>
            </button>
          </div>
        </div>
        <button className="primary" disabled={!name.trim() || busy} onClick={onCreate} data-testid="create-room">
          创建房间
        </button>
      </section>

      <section className="card">
        <h2>加入房间</h2>
        <p className="muted small">输入朋友给你的 4 位房间号。</p>
        <div className="field">
          <label htmlFor="roomid">房间号</label>
          <input
            id="roomid"
            className="mono"
            value={roomId}
            maxLength={4}
            placeholder="ABCD"
            onChange={(e) => setRoomId(e.target.value.toUpperCase())}
            data-testid="room-id-input"
          />
        </div>
        <button
          className="primary"
          disabled={!name.trim() || roomId.trim().length !== 4 || busy}
          onClick={onJoin}
          data-testid="join-room"
        >
          加入房间
        </button>
      </section>

      <section className="card full">
        <h3>玩法速览</h3>
        {/*
          隐藏信息纪律（重要）：
          以下内容属于「玩家不可直接得知」的暗规则，绝不出现在界面上——
            · 牌面点数组成（A/2/4/8）与开局发牌细节
            · 翻转的判定逻辑（同状态翻自己 / 异状态与对手交换）
            · 易位的合法性条件（同状态才可易位）
            · 结算算法（累加取模、破平规则、比分与胜负判定）
          这些规则由服务端裁决，客户端只负责如实呈现服务端告知的结果。
        */}
        <ul className="small muted" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          <li>开局双方各得 4 张面朝下的牌，按位置从左到右编号 1~4。</li>
          <li>翻转：选择其中一个牌位。先手、后手依次完成，然后进入下一步。</li>
          <li>下注：跟注 2 枚、可加注、可停注；上限为对手筹码的一半。</li>
        </ul>
      </section>
    </div>
  );
}
