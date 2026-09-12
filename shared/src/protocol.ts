/**
 * Socket.IO 协议定义 —— 客户端与服务端共用的唯一事实来源。
 */
import type { GameView, Mode, Seat, GameAction } from './types';

/** ---------- 客户端 → 服务端 ---------- */

export const C2S = {
  roomCreate: 'room:create',
  roomJoin: 'room:join',
  roomReady: 'room:ready',
  roomStart: 'room:start',
  roomLeave: 'room:leave',
  gameAction: 'game:action',
  sessionResume: 'session:resume',
  gameRematch: 'game:rematch',
  ping: 'session:ping',
} as const;

/** ---------- 服务端 → 客户端 ---------- */

export const S2C = {
  roomState: 'room:state',
  roomError: 'room:error',
  playerConnected: 'player:connected',
  playerDisconnected: 'player:disconnected',
  gameSettled: 'game:settled',
  gameOver: 'game:over',
  logAppend: 'log:append',
  sessionBound: 'session:bound',
  pong: 'session:pong',
} as const;

/** ---------- 载荷 ---------- */

export interface RoomCreatePayload {
  name: string;
  mode: Mode;
}

export interface RoomJoinPayload {
  roomId: string;
  name: string;
}

export interface RoomReadyPayload {
  ready: boolean;
}

export interface RoomLeavePayload {
  actionId?: string;
}

export interface GameActionPayload {
  action: GameAction;
  /** 客户端生成，用于幂等/防重放 */
  actionId?: string;
  /** 客户端所见版本，用于过期校验 */
  expect?: { round: number; phase: string; turn: Seat };
}

export interface SessionResumePayload {
  roomId: string;
  playerToken: string;
}

export interface GameRematchPayload {
  actionId?: string;
}

/** 会话绑定信息（创建/加入/恢复成功后返回） */
export interface SessionInfo {
  roomId: string;
  playerToken: string;
  seat: Seat;
  mode: Mode;
}

/** 房间级公开信息 */
export interface RoomInfo {
  roomId: string;
  mode: Mode;
  status: 'waiting' | 'playing' | 'paused' | 'gameOver';
  /** 房间是否在等待双方重连 */
  awaitingReconnect: boolean;
}

export interface PlayerBrief {
  seat: Seat;
  name: string;
  connected: boolean;
  ready: boolean;
  /** 仅在与牌局相关时才有意义 */
  chips: number;
}

export interface LogEntry {
  id: number;
  at: number;
  visibility: 'public' | 'private';
  /** private 日志只发给该座位 */
  seat?: Seat;
  kind: string;
  text: string;
}

export interface RoomStatePayload {
  room: RoomInfo;
  players: PlayerBrief[];
  /** 玩家自己的座位；未入座时为 null */
  you: Seat | null;
  /** 对局视图；未开局为 null */
  game: GameView | null;
  logs: LogEntry[];
}

export interface RoomErrorPayload {
  code: string;
  message: string;
}

export interface PlayerPresencePayload {
  seat: Seat;
  name: string;
  /** 重连后再次回到房间时 true */
  reconnected: boolean;
}

export interface SessionBoundPayload extends SessionInfo {
  resumed: boolean;
  room: RoomStatePayload;
}

/** 创建/加入/恢复的统一应答：成功为 SessionBoundPayload，失败为 RoomErrorPayload */
export type SessionAck = SessionBoundPayload | RoomErrorPayload;

/** 客户端 → 服务端事件表 */
export interface ClientToServerEvents {
  [C2S.roomCreate]: (payload: RoomCreatePayload, ack?: (res: SessionAck) => void) => void;
  [C2S.roomJoin]: (payload: RoomJoinPayload, ack?: (res: SessionAck) => void) => void;
  [C2S.roomReady]: (payload: RoomReadyPayload) => void;
  [C2S.roomStart]: () => void;
  [C2S.roomLeave]: (payload?: RoomLeavePayload) => void;
  [C2S.gameAction]: (payload: GameActionPayload, ack?: (res: { ok: boolean; code?: string }) => void) => void;
  [C2S.sessionResume]: (payload: SessionResumePayload, ack?: (res: SessionAck) => void) => void;
  [C2S.gameRematch]: (payload?: GameRematchPayload) => void;
  [C2S.ping]: (cb?: () => void) => void;
}

/** 服务端 → 客户端事件表 */
export interface ServerToClientEvents {
  [S2C.roomState]: (payload: RoomStatePayload) => void;
  [S2C.roomError]: (payload: RoomErrorPayload) => void;
  [S2C.playerConnected]: (payload: PlayerPresencePayload) => void;
  [S2C.playerDisconnected]: (payload: PlayerPresencePayload) => void;
  [S2C.gameSettled]: (payload: { round: number; result: unknown }) => void;
  [S2C.gameOver]: (payload: { winner: Seat; reason: string; chips: [number, number] }) => void;
  [S2C.logAppend]: (payload: { entries: LogEntry[] }) => void;
  [S2C.sessionBound]: (payload: SessionBoundPayload) => void;
  [S2C.pong]: () => void;
}

/** ---------- 本地会话持久化键 ---------- */

export const SESSION_STORAGE_KEY = 'fanzhuan.zuolun.session';

export interface StoredSession {
  roomId: string;
  playerToken: string;
}

/** 错误码 → 中文文案（客户端展示用） */
export const ERROR_TEXT: Record<string, string> = {
  ROOM_NOT_FOUND: '房间不存在，请检查房间号',
  ROOM_FULL: '房间已满（仅限 2 人）',
  ROOM_STARTED: '房间已开局，无法加入',
  ROOM_NOT_WAITING: '房间当前状态不允许该操作',
  ALREADY_IN_ROOM: '你已经在一个房间中，请先离开',
  NOT_IN_ROOM: '你不在任何房间中',
  NOT_SEATED: '你还没有入座',
  NOT_READY: '双方都准备后才能开始',
  NEED_TWO_PLAYERS: '需要两名玩家才能开始',
  RESUME_FAILED: '会话已失效，请重新加入房间',
  BAD_NAME: '昵称不能为空且不超过 12 个字符',
  BAD_ROOM_ID: '房间号格式不正确',
  BAD_MODE: '模式不正确',
  OPPONENT_OFFLINE: '对手已掉线，等待重连中',
  GAME_OVER: '对局已结束',
  NOT_PLAYING: '对局尚未开始',
  NOT_YOUR_TURN: '还没轮到你',
  ALREADY_ACTED: '本阶段你已经行动过了',
  WRONG_PHASE: '当前阶段不允许该操作',
  BAD_SLOT: '牌位必须是 1~4',
  BAD_SLOTS: '请选择两个不同的牌位',
  SWAP_STATE_MISMATCH: '非法易位，请重新选择',
  BET_BAD_AMOUNT: '下注数量不合法',
  BET_INSUFFICIENT_CHIPS: '筹码不足',
  BET_OVER_LIMIT: '超出本轮注额上限',
  ALREADY_STOPPED: '你已经停注了',
  BAD_ACTION: '无效操作',
  TOO_MANY_ATTEMPTS: '非法易位次数过多，请重新选择',
  INTERNAL: '服务器内部错误',
};

export function errorText(code: string): string {
  return ERROR_TEXT[code] ?? code;
}
