/**
 * 客户端 SDK 层：封装 socket 事件与本地会话。
 */
import { io, type Socket } from 'socket.io-client';
import {
  C2S,
  SESSION_STORAGE_KEY,
  type ClientToServerEvents,
  type GameAction,
  type LogEntry,
  type RoomStatePayload,
  type Seat,
  type ServerToClientEvents,
  type StoredSession,
} from '@zuolun/shared';

/** 同源连接：开发态由 Vite 代理到 3000，生产态同端口 */
export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
  autoConnect: true,
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionDelay: 400,
  reconnectionDelayMax: 4000,
  reconnectionAttempts: Infinity,
  timeout: 12_000,
});

export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed?.roomId !== 'string' || typeof parsed?.playerToken !== 'string') return null;
    return { roomId: parsed.roomId, playerToken: parsed.playerToken };
  } catch {
    return null;
  }
}

export function saveSession(s: StoredSession): void {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* 隐私模式忽略 */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** 带 ack 的双向调用；超时抛出可读错误 */
export function emitAck<TReq, TRes>(event: string, payload: TReq, timeoutMs = 8000): Promise<TRes> {
  return new Promise<TRes>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('请求超时，请检查网络或服务器'));
    }, timeoutMs);
    // 事件名在运行时是字符串常量；此处用宽类型规避重载严格匹配
    const raw = socket as unknown as {
      emit: (e: string, p: TReq, cb: (r: TRes) => void) => void;
    };
    raw.emit(event, payload, (res: TRes) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(res);
    });
  });
}

export function sendAction(action: GameAction): Promise<{ ok: boolean; code?: string }> {
  return emitAck<unknown, { ok: boolean; code?: string }>(
    C2S.gameAction,
    { action, actionId: crypto.randomUUID() },
    6000,
  );
}

export function createRoom(name: string, mode: 'normal' | 'extreme') {
  return emitAck<{ name: string; mode: string }, { roomId: string; playerToken: string; seat: Seat; room: RoomStatePayload } | { code: string; message: string }>(
    C2S.roomCreate,
    { name, mode },
  );
}

export function joinRoom(roomId: string, name: string) {
  return emitAck<{ roomId: string; name: string }, { roomId: string; playerToken: string; seat: Seat; room: RoomStatePayload } | { code: string; message: string }>(
    C2S.roomJoin,
    { roomId, name },
  );
}

export function resumeSession(roomId: string, playerToken: string) {
  return emitAck<{ roomId: string; playerToken: string }, { seat: Seat; room: RoomStatePayload } | { code: string; message: string }>(
    C2S.sessionResume,
    { roomId, playerToken },
  );
}

export type { RoomStatePayload, Seat };
