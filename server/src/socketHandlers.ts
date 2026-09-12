/**
 * Socket.IO 事件处理 —— 客户端动作入口（服务端权威）。
 *
 * 纪律：
 *  1. 每次状态变化后，给**每个座位**单独下发个性化 room:state（经 getStateForPlayer 白名单投影）。
 *  2. 请求-应答类事件**必须**回 ack：成功回 SessionBoundPayload，失败回 { code, message }，
 *     否则客户端会一直等待（这是早期的真实缺陷，已修）。
 *  3. 非本座位的信息绝不出现在任何下行包中。
 */
import type { Server, Socket } from 'socket.io';
import {
  C2S,
  ROOM_ID_ALPHABET,
  S2C,
  errorText,
  isMode,
  type ClientToServerEvents,
  type GameAction,
  type GameActionPayload,
  type RoomCreatePayload,
  type RoomErrorPayload,
  type RoomJoinPayload,
  type RoomReadyPayload,
  type RoomStatePayload,
  type Seat,
  type ServerToClientEvents,
  type SessionAck,
  type SessionBoundPayload,
  type SessionResumePayload,
} from '@zuolun/shared';
import { RoomManager, type Room } from './roomManager';
import { log } from './log';

export type IO = Server<ClientToServerEvents, ServerToClientEvents>;
export type Sock = Socket<ClientToServerEvents, ServerToClientEvents>;

const MAX_NAME_LEN = 12;

interface Ctx {
  io: IO;
  manager: RoomManager;
}

function errPayload(code: string, message?: string): RoomErrorPayload {
  return { code, message: message ?? errorText(code) };
}

/** 同时通知 socket（room:error）与 ack（若有） */
function fail(socket: Sock, ack: ((res: SessionAck) => void) | undefined, code: string, message?: string): void {
  const payload = errPayload(code, message);
  socket.emit(S2C.roomError, payload);
  ack?.(payload);
}

function validRoomIdFormat(roomId: unknown): roomId is string {
  if (typeof roomId !== 'string') return false;
  const id = roomId.toUpperCase();
  if (id.length !== 4) return false;
  return [...id].every((ch) => ROOM_ID_ALPHABET.includes(ch));
}

function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name || name.length > MAX_NAME_LEN) return null;
  return name;
}

function roomStateFor(manager: RoomManager, room: Room, seat: Seat | null): RoomStatePayload {
  return manager.roomStatePayload(room, seat);
}

/** 给房间内所有在线座位下发个性化状态 */
function broadcastRoomState(ctx: Ctx, room: Room): void {
  for (const rec of room.seats) {
    if (!rec || !rec.socketId) continue;
    ctx.io.to(rec.socketId).emit(S2C.roomState, roomStateFor(ctx.manager, room, rec.seat));
  }
}

/** 单独给某座位下发状态 */
function emitRoomStateTo(ctx: Ctx, room: Room, seat: Seat): void {
  const rec = room.seats[seat];
  if (!rec || !rec.socketId) return;
  ctx.io.to(rec.socketId).emit(S2C.roomState, roomStateFor(ctx.manager, room, seat));
}

function sessionBoundPayload(
  manager: RoomManager,
  room: Room,
  seat: Seat,
  playerToken: string,
  resumed: boolean,
): SessionBoundPayload {
  return {
    roomId: room.roomId,
    playerToken,
    seat,
    mode: room.mode,
    resumed,
    room: roomStateFor(manager, room, seat),
  };
}

export function registerSocketHandlers(io: IO, manager: RoomManager): void {
  const ctx: Ctx = { io, manager };

  io.on('connection', (socket) => {
    log.debug('socket:connect', { id: socket.id });

    /* ---------------- 创建房间 ---------------- */
    socket.on(C2S.roomCreate, (payload: RoomCreatePayload, ack) => {
      try {
        const name = sanitizeName(payload?.name);
        if (!name) return fail(socket, ack, 'BAD_NAME');
        const mode = payload?.mode;
        if (!isMode(mode)) return fail(socket, ack, 'BAD_MODE');
        if (manager.findBySocket(socket.id)) return fail(socket, ack, 'ALREADY_IN_ROOM');

        const { room, credentials } = manager.createRoom(mode, name);
        manager.bindSocket(room, credentials.seat, socket.id);
        manager.setReady(room, credentials.seat, true);
        socket.join(room.roomId);
        const bound = sessionBoundPayload(manager, room, credentials.seat, credentials.playerToken, false);
        ack?.(bound);
        socket.emit(S2C.sessionBound, bound);
        broadcastRoomState(ctx, room);
      } catch (err) {
        log.error('room:create failed', { err: String(err) });
        fail(socket, ack, 'INTERNAL');
      }
    });

    /* ---------------- 加入房间 ---------------- */
    socket.on(C2S.roomJoin, (payload: RoomJoinPayload, ack) => {
      try {
        const name = sanitizeName(payload?.name);
        if (!name) return fail(socket, ack, 'BAD_NAME');
        if (!validRoomIdFormat(payload?.roomId)) return fail(socket, ack, 'BAD_ROOM_ID');
        if (manager.findBySocket(socket.id)) return fail(socket, ack, 'ALREADY_IN_ROOM');

        const res = manager.joinRoom(String(payload.roomId).toUpperCase(), name);
        if (!res.ok) return fail(socket, ack, res.code);

        const { room, credentials } = res.value;
        manager.bindSocket(room, credentials.seat, socket.id);
        manager.setReady(room, credentials.seat, true);
        socket.join(room.roomId);
        const bound = sessionBoundPayload(manager, room, credentials.seat, credentials.playerToken, false);
        ack?.(bound);
        socket.emit(S2C.sessionBound, bound);
        socket.to(room.roomId).emit(S2C.playerConnected, {
          seat: credentials.seat,
          name,
          reconnected: false,
        });
        manager.pushLog(room, 'public', 'presence', `${name} 已加入`);
        broadcastRoomState(ctx, room);
      } catch (err) {
        log.error('room:join failed', { err: String(err) });
        fail(socket, ack, 'INTERNAL');
      }
    });

    /* ---------------- 准备 ---------------- */
    socket.on(C2S.roomReady, (payload: RoomReadyPayload) => {
      const found = manager.findBySocket(socket.id);
      if (!found) {
        socket.emit(S2C.roomError, errPayload('NOT_IN_ROOM'));
        return;
      }
      const { room, seatRecord } = found;
      manager.setReady(room, seatRecord.seat, payload?.ready !== false);
      const me = manager.playerBrief(room, seatRecord.seat);
      socket.to(room.roomId).emit(S2C.playerConnected, { seat: me.seat, name: me.name, reconnected: false });
      broadcastRoomState(ctx, room);
    });

    /* ---------------- 开始对局 ---------------- */
    socket.on(C2S.roomStart, () => {
      const found = manager.findBySocket(socket.id);
      if (!found) {
        socket.emit(S2C.roomError, errPayload('NOT_IN_ROOM'));
        return;
      }
      const { room } = found;
      if (!manager.allOnline(room)) {
        socket.emit(S2C.roomError, errPayload('OPPONENT_OFFLINE'));
        return;
      }
      const res = manager.startGame(room);
      if (!res.ok) {
        socket.emit(S2C.roomError, errPayload(res.code));
        return;
      }
      log.info('game:start', { roomId: room.roomId });
      broadcastRoomState(ctx, room);
    });

    /* ---------------- 游戏动作 ---------------- */
    socket.on(C2S.gameAction, (payload: GameActionPayload, ack) => {
      try {
        const found = manager.findBySocket(socket.id);
        if (!found) {
          ack?.({ ok: false, code: 'NOT_IN_ROOM' });
          socket.emit(S2C.roomError, errPayload('NOT_IN_ROOM'));
          return;
        }
        const { room, seatRecord } = found;
        const action = payload?.action as GameAction | undefined;
        if (!action || typeof action !== 'object' || typeof (action as { type?: unknown }).type !== 'string') {
          ack?.({ ok: false, code: 'BAD_ACTION' });
          socket.emit(S2C.roomError, errPayload('BAD_ACTION'));
          return;
        }

        // 过期校验：客户端所见版本与服务端不一致 → 拒绝，并回发最新状态
        const expect = payload?.expect;
        const g = room.game;
        if (expect && g) {
          const stale = expect.round !== g.round || expect.phase !== g.phase || expect.turn !== g.turn;
          if (stale) {
            ack?.({ ok: false, code: 'STALE_ACTION' });
            socket.emit(S2C.roomError, errPayload('STALE_ACTION', '操作已过期，请以最新状态为准'));
            emitRoomStateTo(ctx, room, seatRecord.seat);
            return;
          }
        }

        const res = manager.applyGameAction(room, seatRecord.seat, action, payload?.actionId);
        if (!res.ok) {
          ack?.({ ok: false, code: res.code });
          socket.emit(S2C.roomError, errPayload(res.code));
          // 动作被拒时把最新状态回给该玩家，便于客户端收敛（例如非法易位重选）
          if (res.code === 'SWAP_STATE_MISMATCH') emitRoomStateTo(ctx, room, seatRecord.seat);
          return;
        }
        ack?.({ ok: true });
        broadcastRoomState(ctx, room);
      } catch (err) {
        log.error('game:action failed', { err: String(err) });
        ack?.({ ok: false, code: 'INTERNAL' });
        socket.emit(S2C.roomError, errPayload('INTERNAL'));
      }
    });

    /* ---------------- 断线重连 ---------------- */
    socket.on(C2S.sessionResume, (payload: SessionResumePayload, ack) => {
      try {
        const roomId = String(payload?.roomId ?? '').toUpperCase();
        const token = payload?.playerToken;
        if (!roomId || typeof token !== 'string' || token.length < 16) {
          return fail(socket, ack, 'RESUME_FAILED');
        }
        const res = manager.resume(roomId, token);
        if (!res.ok) return fail(socket, ack, 'RESUME_FAILED');

        const { room, seatRecord } = res.value;
        const { reconnected } = manager.bindSocket(room, seatRecord.seat, socket.id);
        socket.join(room.roomId);
        const bound = sessionBoundPayload(manager, room, seatRecord.seat, token, true);
        ack?.(bound);
        socket.emit(S2C.sessionBound, bound);
        if (reconnected || room.seats.some((s) => s && s.seat !== seatRecord.seat)) {
          socket.to(room.roomId).emit(S2C.playerConnected, {
            seat: seatRecord.seat,
            name: seatRecord.name,
            reconnected: true,
          });
          manager.pushLog(room, 'public', 'presence', `${seatRecord.name} 已重连`);
        }
        broadcastRoomState(ctx, room);
      } catch (err) {
        log.error('session:resume failed', { err: String(err) });
        fail(socket, ack, 'INTERNAL');
      }
    });

    /* ---------------- 再来一局 ---------------- */
    socket.on(C2S.gameRematch, () => {
      const found = manager.findBySocket(socket.id);
      if (!found) {
        socket.emit(S2C.roomError, errPayload('NOT_IN_ROOM'));
        return;
      }
      const { room } = found;
      if (!manager.allOnline(room)) {
        socket.emit(S2C.roomError, errPayload('OPPONENT_OFFLINE'));
        return;
      }
      const res = manager.rematch(room);
      if (!res.ok) {
        socket.emit(S2C.roomError, errPayload(res.code));
        return;
      }
      broadcastRoomState(ctx, room);
    });

    /* ---------------- 离开房间 ---------------- */
    socket.on(C2S.roomLeave, () => {
      const found = manager.findBySocket(socket.id);
      if (!found) return;
      const { room, seatRecord } = found;
      socket.to(room.roomId).emit(S2C.playerDisconnected, {
        seat: seatRecord.seat,
        name: seatRecord.name,
        reconnected: false,
      });
      manager.leave(room, seatRecord.seat);
      socket.leave(room.roomId);
      if (manager.getRoom(room.roomId)) broadcastRoomState(ctx, room);
    });

    /* ---------------- 心跳 ---------------- */
    socket.on(C2S.ping, (cb) => {
      if (typeof cb === 'function') cb();
      socket.emit(S2C.pong);
    });

    /* ---------------- 断开 ---------------- */
    socket.on('disconnect', (reason) => {
      const found = manager.markDisconnected(socket.id);
      if (!found) return;
      const { room, seatRecord } = found;
      log.info('socket:disconnect', { roomId: room.roomId, seat: seatRecord.seat, reason });
      socket.to(room.roomId).emit(S2C.playerDisconnected, {
        seat: seatRecord.seat,
        name: seatRecord.name,
        reconnected: false,
      });
      manager.pushLog(room, 'public', 'presence', `${seatRecord.name} 掉线，等待重连`);
      broadcastRoomState(ctx, room);
    });
  });
}
