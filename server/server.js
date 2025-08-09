// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET","POST"] },
  transports: ['websocket', 'polling'],
});

// In-memory stores
const waitingUsers = new Map(); // userId -> { socketId, socket, audioEnabled, videoEnabled, joinTime, token }
const queue = []; // FIFO userIds waiting
const activeRooms = new Map(); // roomId -> { user1, user2, created }
const tokenToUser = new Map(); // token -> { userId, socketId|null, roomId|null, cleanupTimer|null, lastSeen }
const userConnections = new Map(); // userId -> socketId

// Config
const ROOM_RECONNECT_TTL_MS = 2 * 60 * 1000; // keep room alive 2 minutes for reconnect
const TOKEN_CLEANUP_TTL_MS = 5 * 60 * 1000; // cleanup unused tokens after 5 minutes

// Helpers
const genId = () => Math.random().toString(36).slice(2, 11);
const genRoom = () => Math.random().toString(36).slice(2, 14);
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
      console.log(`[SERVER] token ${token} expired and removed`);
    }
    if (cur) cur.cleanupTimer = null;
    broadcastUserCount();
  }, TOKEN_CLEANUP_TTL_MS);
};

const cancelTokenCleanup = (token) => {
  const entry = tokenToUser.get(token);
  if (!entry) return;
  if (entry.cleanupTimer) {
    clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = null;
  }
};

// Remove user from waiting list & queue
const removeFromWaiting = (userId) => {
  waitingUsers.delete(userId);
  const i = queue.indexOf(userId);
  if (i !== -1) queue.splice(i, 1);
};

// pop a valid candidate from queue (skip disconnected ones)
const popCandidate = (excludeId) => {
  while (queue.length > 0) {
    const candidate = queue.shift();
    if (!candidate || candidate === excludeId) continue;
    if (!waitingUsers.has(candidate)) continue;
    const d = waitingUsers.get(candidate);
    if (!d || !io.sockets.sockets.get(d.socketId)) {
      // stale entry
      waitingUsers.delete(candidate);
      continue;
    }
    return { userId: candidate, userData: d };
  }
  return null;
};

const determineInitiator = (u1, d1, u2, d2) => {
  if ((d1.joinTime || 0) < (d2.joinTime || 0)) return { initiator: u1, responder: u2 };
  if ((d2.joinTime || 0) < (d1.joinTime || 0)) return { initiator: u2, responder: u1 };
  return u1 < u2 ? { initiator: u1, responder: u2 } : { initiator: u2, responder: u1 };
};

// Simple debug endpoint
app.get('/debug', (req,res) => {
  res.json({
    tokens: Array.from(tokenToUser.entries()),
    waiting: Array.from(waitingUsers.keys()),
    queue,
    rooms: Array.from(activeRooms.entries()).map(([id, r]) => ({ id, user1: r.user1.id, user2: r.user2.id, created: r.created })),
    userCount: computeUserCount(),
  });
});

io.on('connection', (socket) => {
  // Try reuse token from handshake.auth
  const clientToken = (socket.handshake && socket.handshake.auth && socket.handshake.auth.token) || null;
  let userId, token;

  if (clientToken && tokenToUser.has(clientToken)) {
    const entry = tokenToUser.get(clientToken);
    token = clientToken;
    userId = entry.userId;
    entry.socketId = socket.id;
    entry.lastSeen = Date.now();
    cancelTokenCleanup(token);
    socket.userId = userId;
    socket.token = token;
    userConnections.set(userId, socket.id);
    socket.emit('reconnect_success', { room: entry.roomId || null, userId });
    console.log(`[SERVER] Reattached existing token ${token} -> user ${userId}`);
    // if user was in a room, update room socket refs
    if (entry.roomId && activeRooms.has(entry.roomId)) {
      const room = activeRooms.get(entry.roomId);
      if (room.user1.id === userId) { room.user1.socket = socket; room.user1.socketId = socket.id; }
      if (room.user2.id === userId) { room.user2.socket = socket; room.user2.socketId = socket.id; }
      // notify partner that user reconnected
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
    console.log(`[SERVER] New user ${userId}, token ${token}`);
  }

  // Broadcast current user count
  broadcastUserCount();

  // reconnect_user (compat)
  socket.on('reconnect_user', (data) => {
    const t = data && data.token;
    if (!t) { socket.emit('reconnect_failed'); return; }
    const entry = tokenToUser.get(t);
    if (entry && entry.userId) {
      entry.socketId = socket.id;
      entry.lastSeen = Date.now();
      cancelTokenCleanup(t);
      socket.userId = entry.userId;
      socket.token = t;
      userConnections.set(entry.userId, socket.id);
      socket.emit('reconnect_success', { room: entry.roomId || null, userId: entry.userId });
      console.log(`[SERVER] reconnect_user success for ${entry.userId}`);
      // if in room let partner know
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

  // find_partner
  socket.on('find_partner', (data) => {
    const audioEnabled = (data && data.audioEnabled) !== false;
    const videoEnabled = (data && data.videoEnabled) !== false;
    console.log(`[SERVER] find_partner from ${socket.userId}`);

    // already in a room?
    if (Array.from(activeRooms.values()).some(r => r.user1.id === socket.userId || r.user2.id === socket.userId)) {
      console.log(`[SERVER] ${socket.userId} attempted find_partner but already in a room`);
      return;
    }
    // already waiting?
    if (waitingUsers.has(socket.userId)) {
      console.log(`[SERVER] ${socket.userId} already in waiting`);
      return;
    }

    // try to pop candidate
    const candidate = popCandidate(socket.userId);
    if (candidate) {
      // verify still not in room
      if (Array.from(activeRooms.values()).some(r => r.user1.id === candidate.userId || r.user2.id === candidate.userId)) {
        console.log(`[SERVER] candidate ${candidate.userId} just entered a room; retrying find_partner`);
        // try again (recursively will pop next)
        const rec = popCandidate(socket.userId);
        if (!rec) {
          // nobody left -> add to waiting below
        } else {
          // swap candidate to rec
          candidate.userId = rec.userId; candidate.userData = rec.userData;
        }
      }
    }

    // if found
    if (candidate) {
      const roomId = genRoom();
      // remove candidate from waiting (already removed by popCandidate) and ensure current not in waiting
      waitingUsers.delete(candidate.userId);
      waitingUsers.delete(socket.userId);

      // determine initiator/responder
      const roles = determineInitiator(socket.userId, { joinTime: Date.now() }, candidate.userId, { joinTime: candidate.userData.joinTime || 0 });

      const initiatorSocket = roles.initiator === socket.userId ? socket : candidate.userData.socket;
      const responderSocket = roles.responder === socket.userId ? socket : candidate.userData.socket;

      // create room structure
      const roomData = {
        user1: { id: roles.initiator, socket: initiatorSocket, socketId: initiatorSocket.id, initiator: true },
        user2: { id: roles.responder, socket: responderSocket, socketId: responderSocket.id, initiator: false },
        created: Date.now(),
      };
      activeRooms.set(roomId, roomData);

      // update token -> room
      for (const [t, v] of tokenToUser.entries()) {
        if (v.userId === roles.initiator || v.userId === roles.responder) v.roomId = roomId;
      }

      // notify clients
      try { roomData.user1.socket.emit('room_assigned', { room: roomId, initiator: true, role: 'initiator', partnerId: roles.responder }); } catch(e){ }
      try { roomData.user2.socket.emit('room_assigned', { room: roomId, initiator: false, role: 'responder', partnerId: roles.initiator }); } catch(e){ }

      console.log(`[SERVER] Room ${roomId} created: ${roles.initiator} (init) & ${roles.responder} (resp)`);
      broadcastUserCount();
      return;
    }

    // else push this user into waiting + queue
    waitingUsers.set(socket.userId, { socket, socketId: socket.id, audioEnabled, videoEnabled, joinTime: Date.now(), token: socket.token });
    queue.push(socket.userId);
    console.log(`[SERVER] ${socket.userId} added to waiting (queue len ${queue.length})`);
    broadcastUserCount();
  });

  // join_room
  socket.on('join_room', (data) => {
    const roomToJoin = data && data.room;
    console.log(`[SERVER] ${socket.userId} join_room ${roomToJoin}`);
    const room = activeRooms.get(roomToJoin);
    if (!room) { socket.emit('join_failed', { reason: 'no_room' }); return; }
    const isUser1 = room.user1.id === socket.userId;
    const isUser2 = room.user2.id === socket.userId;
    if (!isUser1 && !isUser2) { socket.emit('join_failed', { reason: 'not_authorized' }); return; }
    if (isUser1) { room.user1.socket = socket; room.user1.socketId = socket.id; }
    if (isUser2) { room.user2.socket = socket; room.user2.socketId = socket.id; }
    socket.emit('room_joined', {
      room: roomToJoin,
      initiator: isUser1 ? room.user1.initiator : room.user2.initiator,
      role: (isUser1 ? room.user1.initiator : room.user2.initiator) ? 'initiator' : 'responder',
      partnerId: isUser1 ? room.user2.id : room.user1.id
    });
    // update token map
    for (const [t, v] of tokenToUser.entries()) {
      if (v.userId === socket.userId) v.roomId = roomToJoin;
    }
    console.log(`[SERVER] ${socket.userId} joined room ${roomToJoin}`);
  });

  // skip
  socket.on('skip', () => {
    const inRoom = Array.from(activeRooms.entries()).find(([_, r]) => r.user1.id === socket.userId || r.user2.id === socket.userId);
    if (inRoom) {
      const [roomId, room] = inRoom;
      const other = room.user1.id === socket.userId ? room.user2 : room.user1;
      const otherSock = io.sockets.sockets.get(other.socketId);
      if (otherSock) otherSock.emit('partner_skipped');
      activeRooms.delete(roomId);
      for (const [t,v] of tokenToUser.entries()) {
        if (v.userId === socket.userId || v.userId === other.id) v.roomId = null;
      }
      console.log(`[SERVER] ${socket.userId} skipped - closed room ${roomId}`);
      broadcastUserCount();
      return;
    }
    // remove from queue/waiting
    removeFromWaiting(socket.userId);
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

  // request_reoffer (responder -> ask initiator to re-offer)
  socket.on('request_reoffer', (data) => {
    const room = activeRooms.get(data && data.room);
    if (!room) return;
    const initiator = room.user1.initiator ? room.user1 : (room.user2.initiator ? room.user2 : null);
    if (!initiator) return;
    const isock = io.sockets.sockets.get(initiator.socketId);
    if (isock) isock.emit('request_reoffer', { room: data.room, requester: socket.userId });
  });

  // disconnect handling
  socket.on('disconnect', () => {
    console.log(`[SERVER] socket disconnected: user ${socket.userId}`);
    // mark token socketId null and schedule cleanup
    for (const [t, e] of tokenToUser.entries()) {
      if (e.userId === socket.userId) {
        e.socketId = null;
        e.lastSeen = Date.now();
        scheduleTokenCleanup(t);
        break;
      }
    }
    // if in waiting, remove
    removeFromWaiting(socket.userId);

    // if in room, notify partner, keep room around for TTL
    for (const [roomId, room] of activeRooms.entries()) {
      if (room.user1.id === socket.userId || room.user2.id === socket.userId) {
        const other = room.user1.id === socket.userId ? room.user2 : room.user1;
        const osock = io.sockets.sockets.get(other.socketId);
        if (osock) osock.emit('partner_disconnected', { room: roomId, partnerId: socket.userId });
        // schedule cleanup if both gone
        setTimeout(() => {
          const r = activeRooms.get(roomId);
          if (!r) return;
          const a = io.sockets.sockets.get(r.user1.socketId);
          const b = io.sockets.sockets.get(r.user2.socketId);
          if (!a && !b) {
            activeRooms.delete(roomId);
            // clear roomId from tokens
            for (const [t,v] of tokenToUser.entries()) {
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

});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`[SERVER] listening on ${PORT}`));
