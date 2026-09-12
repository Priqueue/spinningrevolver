/**
 * 全局状态：连接、会话、房间视图、日志、错误提示。
 * 使用 React Context + useReducer 的轻量实现，避免引入额外状态库。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';
import {
  C2S,
  S2C,
  errorText,
  type LogEntry,
  type RoomStatePayload,
  type Seat,
} from '@zuolun/shared';
import {
  clearSession,
  createRoom,
  joinRoom,
  loadSession,
  resumeSession,
  saveSession,
  socket,
} from './socket';

export interface Session {
  roomId: string;
  playerToken: string;
  seat: Seat;
}

interface State {
  connected: boolean;
  /** 曾经连上过（用于区分「从未连上」与「掉线重连中」） */
  everConnected: boolean;
  connecting: boolean;
  session: Session | null;
  room: RoomStatePayload | null;
  logs: LogEntry[];
  error: string | null;
  toast: string | null;
  /** 正在恢复会话 */
  resuming: boolean;
  /** 恢复失败（房间过期） */
  resumeFailed: boolean;
}

type Action =
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'room'; payload: RoomStatePayload }
  | { type: 'session'; session: Session }
  | { type: 'logs'; entries: LogEntry[] }
  | { type: 'error'; message: string | null }
  | { type: 'toast'; message: string | null }
  | { type: 'resuming'; value: boolean }
  | { type: 'resumeFailed'; value: boolean }
  | { type: 'left' };

const initialState: State = {
  connected: false,
  everConnected: false,
  connecting: true,
  session: null,
  room: null,
  logs: [],
  error: null,
  toast: null,
  resuming: false,
  resumeFailed: false,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'connected':
      return { ...state, connected: true, everConnected: true, connecting: false };
    case 'disconnected':
      return { ...state, connected: false, connecting: false };
    case 'room':
      return {
        ...state,
        room: action.payload,
        logs: action.payload.logs,
        error: null,
      };
    case 'session':
      return { ...state, session: action.session, resumeFailed: false, resuming: false };
    case 'logs': {
      const merged = [...state.logs];
      for (const e of action.entries) {
        if (!merged.some((x) => x.id === e.id && x.at === e.at)) merged.push(e);
      }
      return { ...state, logs: merged.slice(-160) };
    }
    case 'error':
      return { ...state, error: action.message };
    case 'toast':
      return { ...state, toast: action.message };
    case 'resuming':
      return { ...state, resuming: action.value };
    case 'resumeFailed':
      return { ...state, resumeFailed: action.value };
    case 'left':
      return { ...state, session: null, room: null, logs: [], resumeFailed: false };
    default:
      return state;
  }
}

interface StoreValue extends State {
  doCreateRoom: (name: string, mode: 'normal' | 'extreme') => Promise<{ ok: boolean; message?: string }>;
  doJoinRoom: (roomId: string, name: string) => Promise<{ ok: boolean; message?: string }>;
  doReady: (ready: boolean) => void;
  doStart: () => void;
  doLeave: () => void;
  doRematch: () => void;
  setError: (message: string | null) => void;
  setToast: (message: string | null) => void;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  /* ---------- socket 事件绑定 ---------- */
  useEffect(() => {
    function onConnect() {
      dispatch({ type: 'connected' });
      // 重连成功后自动恢复座位
      const saved = loadSession();
      if (saved) {
        dispatch({ type: 'resuming', value: true });
        void resumeSession(saved.roomId, saved.playerToken)
          .then((res) => {
            if ('code' in res) {
              clearSession();
              dispatch({ type: 'resumeFailed', value: true });
              dispatch({ type: 'error', message: errorText(res.code) });
              dispatch({ type: 'left' });
            } else {
              saveSession({ roomId: saved.roomId, playerToken: saved.playerToken });
              dispatch({ type: 'session', session: { ...saved, seat: res.seat } });
              dispatch({ type: 'room', payload: res.room });
            }
          })
          .catch(() => {
            dispatch({ type: 'resuming', value: false });
          });
      }
    }
    function onDisconnect() {
      dispatch({ type: 'disconnected' });
    }
    function onRoomState(payload: RoomStatePayload) {
      dispatch({ type: 'room', payload });
      if (payload.you !== null && payload.room) {
        const saved = loadSession();
        if (saved && saved.roomId === payload.room.roomId) {
          dispatch({ type: 'session', session: { ...saved, seat: payload.you } });
        }
      }
    }
    function onError(payload: { code: string; message?: string }) {
      dispatch({ type: 'error', message: payload.message ?? errorText(payload.code) });
    }
    function onLog(payload: { entries: LogEntry[] }) {
      dispatch({ type: 'logs', entries: payload.entries });
    }
    function onPlayerDisconnected() {
      dispatch({ type: 'toast', message: '对手已掉线，等待重连…' });
    }
    function onPlayerConnected(payload: { name: string; reconnected: boolean }) {
      dispatch({
        type: 'toast',
        message: payload.reconnected ? `${payload.name} 已重连` : `${payload.name} 已加入`,
      });
    }

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on(S2C.roomState, onRoomState);
    socket.on(S2C.roomError, onError);
    socket.on(S2C.logAppend, onLog);
    socket.on(S2C.playerDisconnected, onPlayerDisconnected);
    socket.on(S2C.playerConnected, onPlayerConnected);
    if (socket.connected) onConnect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off(S2C.roomState, onRoomState);
      socket.off(S2C.roomError, onError);
      socket.off(S2C.logAppend, onLog);
      socket.off(S2C.playerDisconnected, onPlayerDisconnected);
      socket.off(S2C.playerConnected, onPlayerConnected);
    };
  }, []);

  /* ---------- toast 自动消失 ---------- */
  useEffect(() => {
    if (!state.toast) return;
    const t = window.setTimeout(() => dispatch({ type: 'toast', message: null }), 3200);
    return () => window.clearTimeout(t);
  }, [state.toast]);

  const doCreateRoom = useCallback(async (name: string, mode: 'normal' | 'extreme') => {
    dispatch({ type: 'error', message: null });
    try {
      const res = await createRoom(name, mode);
      if ('code' in res) {
        dispatch({ type: 'error', message: res.message ?? errorText(res.code) });
        return { ok: false, message: res.message };
      }
      const session = { roomId: res.roomId, playerToken: res.playerToken, seat: res.seat };
      saveSession(session);
      dispatch({ type: 'session', session });
      dispatch({ type: 'room', payload: res.room });
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : '创建房间失败';
      dispatch({ type: 'error', message });
      return { ok: false, message };
    }
  }, []);

  const doJoinRoom = useCallback(async (roomId: string, name: string) => {
    dispatch({ type: 'error', message: null });
    try {
      const res = await joinRoom(roomId.trim().toUpperCase(), name);
      if ('code' in res) {
        dispatch({ type: 'error', message: res.message ?? errorText(res.code) });
        return { ok: false, message: res.message };
      }
      const session = { roomId: res.roomId, playerToken: res.playerToken, seat: res.seat };
      saveSession(session);
      dispatch({ type: 'session', session });
      dispatch({ type: 'room', payload: res.room });
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : '加入房间失败';
      dispatch({ type: 'error', message });
      return { ok: false, message };
    }
  }, []);

  const doReady = useCallback((ready: boolean) => {
    socket.emit(C2S.roomReady, { ready });
  }, []);

  const doStart = useCallback(() => {
    socket.emit(C2S.roomStart);
  }, []);

  const doRematch = useCallback(() => {
    socket.emit(C2S.gameRematch, {});
  }, []);

  const doLeave = useCallback(() => {
    socket.emit(C2S.roomLeave, {});
    clearSession();
    dispatch({ type: 'left' });
  }, []);

  const value = useMemo<StoreValue>(
    () => ({
      ...state,
      doCreateRoom,
      doJoinRoom,
      doReady,
      doStart,
      doLeave,
      doRematch,
      setError: (message) => dispatch({ type: 'error', message }),
      setToast: (message) => dispatch({ type: 'toast', message }),
    }),
    [state, doCreateRoom, doJoinRoom, doReady, doStart, doLeave, doRematch],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore 必须在 StoreProvider 内使用');
  return ctx;
}
