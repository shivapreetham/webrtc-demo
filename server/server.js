// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ['websocket', 'polling'],
});

// --- In-memory stores ---
const waitingUsers = new Map();         // userId -> { socketId, socket, audioEnabled, videoEnabled, joinTime, token }
const queue = [];                       // FIFO queue of userIds
const activeRooms = new Map();          // roomId -> { user1, user2, created }
const tokenToUser = new Map();          // token -> { userId, socketId|null, roomId|null, cleanupTimer|null, lastSeen }
const userConnections = new Map();      // userId -> socketId

// Config
const ROOM_RECONNECT_TTL_MS = 2 * 60 * 1000;   // keep room alive for reconnects
const TOKEN_CLEANUP_TTL_MS = 5 * 60 * 1000;    // cleanup unused tokens after this

// Helpers
const genId = () => Math.random().toString(36).substr(2, 9);
const genRoom = () => Math.random().toString(36).substr(2, 12);
const genToken = () => crypto.randomBytes(16).toString('hex');

const computeUserCount = () => {
  let n = 0;
  for (const [, v] of tokenToUser.entries()) {
    if (v.socketId) n++;
  }
  return n;
};

const broadcastUserCount = () => {
  io.emit('user_count', { count: computeUserCount() });
};

const scheduleTokenCleanup = (token) => {
  const entry = tokenToUser.get(token);
  if (!entry) return;
  if (entry.cleanupTimer) return;
  entry.cleanupTimer = setTimeout(() => {
    const cur = tokenToUser.get(token);
    if (cur && !cur.socketId && !cur.roomId) {
      tokenToUser.delete(token);
      console.log(`[SERVER] Token expired and removed: ${token}`);
    }
    if (cur) cur.cleanupTimer = null;
    broadcastUserCount();
  }, TOKEN_CLEANUP_TTL_MS);
};

const cancelTokenCleanup = (token) => {
  const entry = tokenToUser.get(token);
  if (entry && entry.cleanupTimer) {
    clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = null;
  }
};

const removeFromWaiting = (userId) => {
  waitingUsers.delete(userId);
  const i = queue.indexOf(userId);
  if (i !== -1) queue.splice(i, 1);
};

const popCandidate = (excludeId) => {
  while (queue.length > 0) {
    const cand = queue.shift();
    if (!cand || cand === excludeId) continue;
    if (!waitingUsers.has(cand)) continue;
    const d = waitingUsers.get(cand);
    if (!d || !io.sockets.sockets.get(d.socketId)) {
      waitingUsers.delete(cand);
      continue;
    }
    return { userId: cand, userData: d };
  }
  return null;
};

const determineInitiator = (aId, aData, bId, bData) => {
  if ((aData.joinTime || 0) < (bData.joinTime || 0)) return { initiator: aId, responder: bId };
  if ((bData.joinTime || 0) < (aData.joinTime || 0)) return { initiator: bId, responder: aId };
  return aId < bId ? { initiator: aId, responder: bId } : { initiator: bId, responder: aId };
};

// debug route
app.get('/debug', (_req, res) => {
  res.json({
    tokens: Array.from(tokenToUser.entries()),
    waiting: Array.from(waitingUsers.keys()),
    queue,
    rooms: Array.from(activeRooms.entries()).map(([id, r]) => ({ id, user1: r.user1.id, user2: r.user2.id, created: r.created })),
    userCount: computeUserCount()
  });
});

// Socket logic
io.on('connection', (socket) => {
  // Attempt to reuse token from handshake auth (sent by client when connecting)
  const handshakeToken = (socket.handshake && socket.handshake.auth && socket.handshake.auth.token) || null;
  let userId, token;

  if (handshakeToken && tokenToUser.has(handshakeToken)) {
    const entry = tokenToUser.get(handshakeToken);
    token = handshakeToken;
    userId = entry.userId;
    // attach socket
    entry.socketId = socket.id;
    entry.lastSeen = Date.now();
    cancelTokenCleanup(token);
    socket.userId = userId;
    socket.token = token;
    userConnections.set(userId, socket.id);
    socket.emit('reconnect_success', { room: entry.roomId || null, userId });
    console.log(`[SERVER] Reattached token ${token} -> user ${userId}`);
    // update activeRooms socket refs if present
    if (entry.roomId && activeRooms.has(entry.roomId)) {
      const room = activeRooms.get(entry.roomId);
      if (room.user1.id === userId) { room.user1.socket = socket; room.user1.socketId = socket.id; }
      if (room.user2.id === userId) { room.user2.socket = socket; room.user2.socketId = socket.id; }
      const partner = room.user1.id === userId ? room.user2 : room.user1;
      const partnerSock = io.sockets.sockets.get(partner.socketId);
      if (partnerSock) partnerSock.emit('partner_reconnected', { room: entry.roomId, partnerId: userId });
    }
  } else {
    // New user
    userId = genId();
    token = genToken();
    socket.userId = userId;
    socket.token = token;
    tokenToUser.set(token, { userId, socketId: socket.id, roomId: null, cleanupTimer: null, lastSeen: Date.now() });
    userConnections.set(userId, socket.id);
    socket.emit('welcome', { userId, token });
    console.log(`[SERVER] New user ${userId} connected (socket ${socket.id})`);
  }

  // Broadcast user count
  broadcastUserCount();

  // backwards compat
  socket.on('reconnect_user', (data) => {
    const clientToken = data && data.token;
    if (!clientToken) { socket.emit('reconnect_failed'); return; }
    const entry = tokenToUser.get(clientToken);
    if (entry && entry.userId) {
      entry.socketId = socket.id;
      entry.lastSeen = Date.now();
      cancelTokenCleanup(clientToken);
      socket.userId = entry.userId;
      socket.token = clientToken;
      userConnections.set(entry.userId, socket.id);
      socket.emit('reconnect_success', { room: entry.roomId || null, userId: entry.userId });
      console.log(`[SERVER] reconnect_user success for ${entry.userId}`);
      if (entry.roomId && activeRooms.has(entry.roomId)) {
        const room = activeRooms.get(entry.roomId);
        const partner = room.user1.id === entry.userId ? room.user2 : room.user1;
        const psock = io.sockets.sockets.get(partner.socketId);
        if (psock) psock.emit('partner_reconnected', { room: entry.roomId, partnerId: entry.userId });
      }
      broadcastUserCount();
      return;
    }
    socket.emit('reconnect_failed');
  });

  socket.on('find_partner', (data) => {
    const audioEnabled = (data && data.audioEnabled) !== false;
    const videoEnabled = (data && data.videoEnabled) !== false;
    console.log(`[SERVER] find_partner from ${socket.userId}`);

    // prevent if already in room or waiting
    if (Array.from(activeRooms.values()).some(r => r.user1.id === socket.userId || r.user2.id === socket.userId)) {
      console.log(`[SERVER] ${socket.userId} already in room`);
      return;
    }
    if (waitingUsers.has(socket.userId)) {
      console.log(`[SERVER] ${socket.userId} already waiting`);
      return;
    }

    // try pop a candidate
    const candidate = popCandidate(socket.userId);
    if (candidate) {
      const roomId = genRoom();
      // remove candidate from waiting (popCandidate already popped from queue)
      waitingUsers.delete(candidate.userId);
      // remove any lingering waiting for current user (safety)
      waitingUsers.delete(socket.userId);

      const roles = determineInitiator(socket.userId, { joinTime: Date.now() }, candidate.userId, { joinTime: candidate.userData.joinTime || 0 });

      const initiatorSocket = roles.initiator === socket.userId ? socket : candidate.userData.socket;
      const initiatorSocketId = initiatorSocket.id;
      const responderSocket = roles.responder === socket.userId ? socket : candidate.userData.socket;
      const responderSocketId = responderSocket.id;

      const roomData = {
        user1: { id: roles.initiator, socket: initiatorSocket, socketId: initiatorSocketId, initiator: true },
        user2: { id: roles.responder, socket: responderSocket, socketId: responderSocketId, initiator: false },
        created: Date.now()
      };

      activeRooms.set(roomId, roomData);

      // update token->room
      for (const [tkn, v] of tokenToUser.entries()) {
        if (v.userId === roles.initiator || v.userId === roles.responder) v.roomId = roomId;
      }

      // notify
      try { roomData.user1.socket.emit('room_assigned', { room: roomId, initiator: true, role: 'initiator', partnerId: roles.responder }); } catch(e){ }
      try { roomData.user2.socket.emit('room_assigned', { room: roomId, initiator: false, role: 'responder', partnerId: roles.initiator }); } catch(e){ }

      console.log(`[SERVER] Room ${roomId} created: ${roles.initiator} (init) & ${roles.responder} (resp)`);
      broadcastUserCount();
      return;
    }

    // else join waiting queue
    waitingUsers.set(socket.userId, { socket, socketId: socket.id, audioEnabled, videoEnabled, joinTime: Date.now(), token: socket.token });
    queue.push(socket.userId);
    console.log(`[SERVER] ${socket.userId} added to waiting (queue len: ${queue.length})`);
    broadcastUserCount();
  });

  socket.on('join_room', (data) => {
    const roomToJoin = data && data.room;
    console.log(`[SERVER] ${socket.userId} join_room ${roomToJoin}`);
    const room = activeRooms.get(roomToJoin);
    if (!room) { socket.emit('join_failed', { reason: 'no_room' }); return; }

    // update socket references if token mapping matches
    const clientToken = data && data.token;
    if (clientToken && tokenToUser.has(clientToken)) {
      const entry = tokenToUser.get(clientToken);
      if (entry.userId === socket.userId) {
        entry.socketId = socket.id;
        userConnections.set(socket.userId, socket.id);
        if (room.user1.id === socket.userId) { room.user1.socket = socket; room.user1.socketId = socket.id; }
        if (room.user2.id === socket.userId) { room.user2.socket = socket; room.user2.socketId = socket.id; }
      }
    }

    const isUser1 = room.user1.id === socket.userId;
    const isUser2 = room.user2.id === socket.userId;
    if (isUser1 || isUser2) {
      const userData = isUser1 ? room.user1 : room.user2;
      const partnerData = isUser1 ? room.user2 : room.user1;
      socket.emit('room_joined', { room: roomToJoin, initiator: userData.initiator, role: userData.initiator ? 'initiator' : 'responder', partnerId: partnerData.id });
      console.log(`[SERVER] ${socket.userId} joined room ${roomToJoin} as ${userData.initiator ? 'initiator' : 'responder'}`);
    } else {
      socket.emit('join_failed', { reason: 'not_authorized' });
    }
  });

  socket.on('skip', () => {
    const inRoom = Array.from(activeRooms.entries()).find(([_, r]) => r.user1.id === socket.userId || r.user2.id === socket.userId);
    if (inRoom) {
      const [roomId, room] = inRoom;
      const other = room.user1.id === socket.userId ? room.user2 : room.user1;
      const otherSock = io.sockets.sockets.get(other.socketId);
      if (otherSock) otherSock.emit('partner_skipped');
      activeRooms.delete(roomId);
      for (const [tkn, v] of tokenToUser.entries()) {
        if (v.userId === socket.userId || v.userId === other.id) v.roomId = null;
      }
      console.log(`[SERVER] ${socket.userId} skipped - closed room ${roomId}`);
      broadcastUserCount();
      return;
    }
    // else remove from waiting
    removeFromWaiting(socket.userId);
    console.log(`[SERVER] ${socket.userId} skipped while waiting`);
    broadcastUserCount();
  });

  // signaling
  socket.on('offer', (data) => {
    const room = activeRooms.get(data && data.room);
    if (!room) return;
    const isUser1 = room.user1.id === socket.userId;
    const isUser2 = room.user2.id === socket.userId;
    if (!isUser1 && !isUser2) return;
    const target = isUser1 ? room.user2 : room.user1;
    const tsock = io.sockets.sockets.get(target.socketId);
    if (tsock) { tsock.emit('offer', { offer: data.offer, senderId: socket.userId }); console.log(`[SERVER] forwarded offer ${socket.userId} -> ${target.id}`); }
  });

  socket.on('answer', (data) => {
    const room = activeRooms.get(data && data.room);
    if (!room) return;
    const isUser1 = room.user1.id === socket.userId;
    const isUser2 = room.user2.id === socket.userId;
    if (!isUser1 && !isUser2) return;
    const target = isUser1 ? room.user2 : room.user1;
    const tsock = io.sockets.sockets.get(target.socketId);
    if (tsock) { tsock.emit('answer', { answer: data.answer, senderId: socket.userId }); console.log(`[SERVER] forwarded answer ${socket.userId} -> ${target.id}`); }
  });

  socket.on('ice-candidate', (data) => {
    const room = activeRooms.get(data && data.room);
    if (!room) return;
    const isUser1 = room.user1.id === socket.userId;
    const isUser2 = room.user2.id === socket.userId;
    if (!isUser1 && !isUser2) return;
    const target = isUser1 ? room.user2 : room.user1;
    const tsock = io.sockets.sockets.get(target.socketId);
    if (tsock) tsock.emit('ice-candidate', { candidate: data.candidate, senderId: socket.userId });
  });

  socket.on('request_reoffer', (data) => {
    const room = activeRooms.get(data && data.room);
    if (!room) return;
    const initiator = room.user1.initiator ? room.user1 : (room.user2.initiator ? room.user2 : null);
    if (!initiator) return;
    const isock = io.sockets.sockets.get(initiator.socketId);
    if (isock) isock.emit('request_reoffer', { room: data.room, requester: socket.userId });
  });

  socket.on('disconnect', () => {
    console.log(`[SERVER] socket disconnected for user ${socket.userId}`);
    // mark token's socketId null & schedule cleanup
    for (const [t, e] of tokenToUser.entries()) {
      if (e.userId === socket.userId) {
        e.socketId = null;
        e.lastSeen = Date.now();
        scheduleTokenCleanup(t);
        break;
      }
    }

    // remove from waiting
    removeFromWaiting(socket.userId);

    // if in a room, notify partner and keep room for TTL
    for (const [roomId, room] of activeRooms.entries()) {
      if (room.user1.id === socket.userId || room.user2.id === socket.userId) {
        const other = room.user1.id === socket.userId ? room.user2 : room.user1;
        const osock = io.sockets.sockets.get(other.socketId);
        if (osock) osock.emit('partner_disconnected', { room: roomId, partnerId: socket.userId });
        // schedule removal if both disconnected
        setTimeout(() => {
          const r = activeRooms.get(roomId);
          if (!r) return;
          const a = io.sockets.sockets.get(r.user1.socketId);
          const b = io.sockets.sockets.get(r.user2.socketId);
          if (!a && !b) {
            activeRooms.delete(roomId);
            for (const [tkn, v] of tokenToUser.entries()) {
              if (v.userId === r.user1.id || v.userId === r.user2.id) v.roomId = null;
            }
            console.log(`[SERVER] room ${roomId} expired (both disconnected)`);
            broadcastUserCount();
          }
        }, ROOM_RECONNECT_TTL_MS + 500);
        break;
      }
    }

    broadcastUserCount();
  });

}); // end io.on

// Periodic cleanup/logging
setInterval(() => {
  const now = Date.now();
  let cleanedRooms = 0;
  for (const [roomId, roomData] of activeRooms.entries()) {
    if (now - roomData.created > 10 * 60 * 1000) {
      activeRooms.delete(roomId);
      cleanedRooms++;
      for (const [tkn, v] of tokenToUser.entries()) {
        if (v.userId === roomData.user1.id || v.userId === roomData.user2.id) v.roomId = null;
      }
      console.log(`[SERVER] Cleaned old room ${roomId}`);
    }
  }
  console.log(`[SERVER] Status - Active rooms: ${activeRooms.size}, Queue: ${queue.length}, Waiting: ${waitingUsers.size}, Tokens: ${tokenToUser.size}, UsersConnected: ${computeUserCount()}, Cleaned: ${cleanedRooms}`);
}, 30000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`[SERVER] listening on ${PORT}`));
