/**
 * 服务端入口：单 Node 服务同时托管前端静态资源与 Socket.IO。
 *
 * 环境变量：
 *   PORT        监听端口（默认 3000）
 *   NODE_ENV    production 时托管 client/dist
 *   LOG_LEVEL   debug|info|warn|error
 *   CLIENT_DIR  自定义前端构建目录（默认 <cwd>/client/dist）
 */
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import { RoomManager } from './roomManager';
import { registerSocketHandlers, type IO } from './socketHandlers';
import { log } from './log';

const PORT = Number(process.env.PORT ?? 3000);
const NODE_ENV = process.env.NODE_ENV ?? 'development';
const CLIENT_DIR = process.env.CLIENT_DIR ?? path.resolve(process.cwd(), 'client', 'dist');

export function createApp() {
  const app = express();
  const httpServer = createServer(app);
  const io: IO = new Server(httpServer, {
    cors: { origin: true, credentials: true },
    pingInterval: 10_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 1e5,
  });
  const manager = new RoomManager();
  registerSocketHandlers(io, manager);

  app.get('/healthz', (_req, res) => {
    res.json({
      ok: true,
      uptime: Math.round(process.uptime()),
      rooms: manager.size,
      env: NODE_ENV,
      version: process.env.npm_package_version ?? '1.0.0',
    });
  });

  app.get('/api/room/:roomId', (req, res) => {
    const room = manager.getRoom(String(req.params.roomId ?? ''));
    if (!room) return res.status(404).json({ ok: false, code: 'ROOM_NOT_FOUND' });
    res.json({
      ok: true,
      room: {
        roomId: room.roomId,
        mode: room.mode,
        started: room.game !== null,
        players: room.seats.filter(Boolean).map((s) => ({ seat: s!.seat, name: s!.name })),
      },
    });
  });

  // 前端静态资源（生产构建产物）
  if (existsSync(CLIENT_DIR)) {
    app.use(express.static(CLIENT_DIR, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/socket\.io|\/healthz|\/api).*/, (_req, res) => {
      res.sendFile(path.join(CLIENT_DIR, 'index.html'));
    });
    log.info('static:serving', { dir: CLIENT_DIR });
  } else {
    log.warn('static:missing', { dir: CLIENT_DIR, hint: '请先执行 npm run build:client' });
    app.get('/', (_req, res) => {
      res
        .status(200)
        .type('text/plain')
        .send('翻转左轮服务端已启动。前端尚未构建：请运行 npm run build:client（开发模式请用 npm run dev）。');
    });
  }

  return { app, httpServer, io, manager };
}

const isMain = process.argv[1] ? /index\.(ts|cjs|js|mjs)$/.test(process.argv[1]) : false;
if (isMain) {
  const { httpServer } = createApp();
  httpServer.listen(PORT, () => {
    log.info('server:listening', { port: PORT, env: NODE_ENV });
    // eslint-disable-next-line no-console
    console.log(`翻转左轮服务已启动： http://localhost:${PORT}`);
  });
}
