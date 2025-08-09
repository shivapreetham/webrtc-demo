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
const waitingUsers = new Map(); // userId -> { socket, socketId, audioEnabled, videoEnabled, joinTime, token }
const queue = []; // FIFO queue of waiting userIds
const activeRooms = new Map(); // roomId -> { user1, user2, created }
const tokenToUser = new Map(); // token -> { userId, socketId|null, roomId|null, cleanupTimer|null }
const userConnections = new Map(); // userId -> socketId
let userCount = 0;

// Config
const ROOM_RECONNECT_TTL_MS = 2 * 60 * 1000; // 2 minutes

// Helpers
const generateId = () => Math.random().toString(36).substr(2, 9);
const generateRoomId = () => Math.random().toString(36).substr(2, 12);
const generateToken = () => crypto.randomBytes(16).toString('hex');

const broadcastUserCount = () => {
  io.emit('user_count', { count: userCount });
};

const cleanupUserFromWaiting = (userId) => {
  if (waitingUsers.has(userId)) waitingUsers.delete(userId);
  const idx = queue.indexOf(userId);
  if (idx !== -1) queue.splice(idx, 1);
};

const scheduleTokenCleanup = (token) => {
  const e = tokenToUser.get(token);
  if (!e) return;
  if (e.cleanupTimer) return;
  e.cleanupTimer = setTimeout(() => {
    const cur = tokenToUser.get(token);
    if (cur && !cur.socketId && !cur.roomId) {
      tokenToUser.delete(token);
      console.log(`[SERVER] Token expired and removed: ${token}`);
    }
    if (cur) cur.cleanupTimer = null;
  }, ROOM_RECONNECT_TTL_MS);
};

const cancelTokenCleanup = (token) => {
  const e = tokenToUser.get(token);
  if (e && e.cleanupTimer) {
    clearTimeout(e.cleanupTimer);
    e.cleanupTimer = null;
  }
};

const cleanupRoomIfBothDisconnected = (roomId) => {
  const room = activeRooms.get(roomId);
  if (!room) return;
  const alive1 = io.sockets.sockets.get(room.user1.socketId);
  const alive2 = io.sockets.sockets.get(room.user2.socketId);
  if (!alive1 && !alive2) {
    activeRooms.delete(roomId);
    console.log(`[SERVER] Room ${roomId} removed (both disconnected)`);
    // update tokenToUser entries
    for (const [tkn, ud] of tokenToUser.entries()) {
      if (ud.userId === room.user1.id || ud.userId === room.user2.id) ud.roomId = null;
    }
  }
};

// Pairing helper: pop queue until find live waiting user
const popCandidateFromQueue = (requesterId) => {
  while (queue.length > 0) {
    const cand = queue.shift();
    if (!cand || cand === requesterId) continue;
    if (!waitingUsers.has(cand)) continue;
    const candData = waitingUsers.get(cand);
    if (!candData || !io.sockets.sockets.get(candData.socketId)) {
      waitingUsers.delete(cand);
      continue;
    }
    return { userId: cand, userData: candData };
  }
  return null;
};

// Determine initiator by joinTime or id order
const determineInitiator = (aId, aData, bId, bData) => {
  if ((aData.joinTime||0) < (bData.joinTime||0)) return { initiator: aId, responder: bId };
  if ((bData.joinTime||0) < (aData.joinTime||0)) return { initiator: bId, responder: aId };
  return aId < bId ? { initiator: aId, responder: bId } : { initiator: bId, responder: aId };
};

// Basic debug endpoint (only in dev)
app.get('/debug', (req, res) => {
  res.json({
    usersWaiting: Array.from(waitingUsers.keys()),
    queue,
    activeRooms: Array.from(activeRooms.entries()).map(([id, r]) => ({
      id, user1: r.user1.id, user2: r.user2.id, created: r.created
    })),
    tokens: Array.from(tokenToUser.entries()).map(([t, v]) => ({ token: t, userId: v.userId, roomId: v.roomId, socketId: v.socketId })),
    userCount
  });
});

// Socket.IO
io.on('connection', (socket) => {
  // If client passed token in auth, try to reattach
  const clientToken = (socket.handshake && socket.handshake.auth && socket.handshake.auth.token) || null;
  let userId, token;
  if (clientToken && tokenToUser.has(clientToken)) {
    const entry = tokenToUser.get(clientToken);
    token = clientToken;
    userId = entry.userId;
    entry.socketId = socket.id;
    cancelTokenCleanup(token);
    socket.userId = userId;
    socket.token = token;
    userConnections.set(userId, socket.id);
    socket.emit('reconnect_success', { room: entry.roomId || null, userId });
    console.log(`[SERVER] Reattached socket to existing token ${token} -> user ${userId}`);
    // If user had a room, update room references and notify partner
    if (entry.roomId && activeRooms.has(entry.roomId)) {
      const room = activeRooms.get(entry.roomId);
      if (room.user1.id === userId) { room.user1.socket = socket; room.user1.socketId = socket.id; }
      if (room.user2.id === userId) { room.user2.socket = socket; room.user2.socketId = socket.id; }
      const partner = room.user1.id === userId ? room.user2 : room.user1;
      const otherSocket = io.sockets.sockets.get(partner.socketId);
      if (otherSocket) otherSocket.emit('partner_reconnected', { room: entry.roomId, partnerId: userId });
    }
  } else {
    // new user
    userId = generateId();
    token = generateToken();
    socket.userId = userId;
    socket.token = token;
    tokenToUser.set(token, { userId, socketId: socket.id, roomId: null, cleanupTimer: null });
    userConnections.set(userId, socket.id);
    userCount++;
    broadcastUserCount();
    socket.emit('welcome', { userId, token });
    console.log(`[SERVER] New user ${userId} connected (socket ${socket.id}). Total users: ${userCount}`);
  }

  // reconnect_user (backwards compat)
  socket.on('reconnect_user', (data) => {
    const clientToken = data && data.token;
    if (!clientToken) { socket.emit('reconnect_failed'); return; }
    const entry = tokenToUser.get(clientToken);
    if (entry && entry.userId) {
      entry.socketId = socket.id;
      socket.userId = entry.userId;
      socket.token = clientToken;
      userConnections.set(entry.userId, socket.id);
      cancelTokenCleanup(clientToken);
      socket.emit('reconnect_success', { room: entry.roomId || null, userId: entry.userId });
      console.log(`[SERVER] reconnect_user success for ${entry.userId}`);
      if (entry.roomId && activeRooms.has(entry.roomId)) {
        const room = activeRooms.get(entry.roomId);
        const partner = room.user1.id === entry.userId ? room.user2 : room.user1;
        const partnerSocket = io.sockets.sockets.get(partner.socketId);
        if (partnerSocket) partnerSocket.emit('partner_reconnected', { room: entry.roomId, partnerId: entry.userId });
      }
    } else {
      socket.emit('reconnect_failed');
    }
  });

  // find_partner
  socket.on('find_partner', (data) => {
    const audioEnabled = (data && data.audioEnabled) !== false;
    const videoEnabled = (data && data.videoEnabled) !== false;
    console.log(`[SERVER] find_partner from ${socket.userId}`);
    // Avoid pairing if already in room or waiting
    if (Array.from(activeRooms.values()).some(r => r.user1.id === socket.userId || r.user2.id === socket.userId)) {
      console.log(`[SERVER] ${socket.userId} already in a room`);
      return;
    }
    if (waitingUsers.has(socket.userId)) {
      console.log(`[SERVER] ${socket.userId} already waiting`);
      return;
    }
    // try pop candidate
    const candidate = popCandidateFromQueue(socket.userId);
    if (candidate) {
      const roomId = generateRoomId();
      waitingUsers.delete(candidate.userId);
      // create roles
      const roles = determineInitiator(socket.userId, { joinTime: Date.now() }, candidate.userId, { joinTime: candidate.userData.joinTime });
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
      // update tokens
      for (const [tkn, v] of tokenToUser.entries()) {
        if (v.userId === roles.initiator || v.userId === roles.responder) v.roomId = roomId;
      }
      // notify both
      if (roomData.user1.socket) roomData.user1.socket.emit('room_assigned', { room: roomId, initiator: true, role: 'initiator', partnerId: roles.responder });
      if (roomData.user2.socket) roomData.user2.socket.emit('room_assigned', { room: roomId, initiator: false, role: 'responder', partnerId: roles.initiator });
      console.log(`[SERVER] Room ${roomId} created: ${roles.initiator} (init) & ${roles.responder} (resp)`);
      return;
    }
    // otherwise add to waiting queue and push id
    waitingUsers.set(socket.userId, { socket, socketId: socket.id, audioEnabled, videoEnabled, joinTime: Date.now(), token: socket.token });
    queue.push(socket.userId);
    console.log(`[SERVER] ${socket.userId} added to waiting (queue len: ${queue.length})`);
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
    console.log(`[SERVER] ${socket.userId} joined room ${roomToJoin} as ${isUser1 || isUser2 ? (isUser1 ? (room.user1.initiator ? 'initiator' : 'responder') : (room.user2.initiator ? 'initiator' : 'responder')) : 'unknown'}`);
  });

  // skip
  socket.on('skip', () => {
    // If in active room, notify partner and remove
    const userRoom = Array.from(activeRooms.entries()).find(([_, r]) => r.user1.id === socket.userId || r.user2.id === socket.userId);
    if (userRoom) {
      const [roomId, roomData] = userRoom;
      const otherUser = roomData.user1.id === socket.userId ? roomData.user2 : roomData.user1;
      const otherSocket = io.sockets.sockets.get(otherUser.socketId);
      if (otherSocket) otherSocket.emit('partner_skipped');
      activeRooms.delete(roomId);
      for (const [tkn, ud] of tokenToUser.entries()) {
        if (ud.userId === socket.userId || ud.userId === otherUser.id) ud.roomId = null;
      }
      return;
    }
    // if waiting, remove from waiting
    cleanupUserFromWaiting(socket.userId);
  });

  // signaling events
  socket.on('offer', (data) => {
    const room = activeRooms.get(data && data.room);
    if (!room) return;
    const isUser1 = room.user1.id === socket.userId;
    const isUser2 = room.user2.id === socket.userId;
    if (!isUser1 && !isUser2) return;
    const target = isUser1 ? room.user2 : room.user1;
    const targetSocket = io.sockets.sockets.get(target.socketId);
    if (targetSocket) {
      // forward
      targetSocket.emit('offer', { offer: data.offer, senderId: socket.userId });
      console.log(`[SERVER] Forwarded offer from ${socket.userId} to ${target.id}`);
    }
  });

  socket.on('answer', (data) => {
    const room = activeRooms.get(data && data.room);
    if (!room) return;
    const isUser1 = room.user1.id === socket.userId;
    const isUser2 = room.user2.id === socket.userId;
    if (!isUser1 && !isUser2) return;
    const target = isUser1 ? room.user2 : room.user1;
    const targetSocket = io.sockets.sockets.get(target.socketId);
    if (targetSocket) {
      targetSocket.emit('answer', { answer: data.answer, senderId: socket.userId });
      console.log(`[SERVER] Forwarded answer from ${socket.userId} to ${target.id}`);
    }
  });

  socket.on('ice-candidate', (data) => {
    const room = activeRooms.get(data && data.room);
    if (!room) return;
    const isUser1 = room.user1.id === socket.userId;
    const isUser2 = room.user2.id === socket.userId;
    if (!isUser1 && !isUser2) return;
    const target = isUser1 ? room.user2 : room.user1;
    const targetSocket = io.sockets.sockets.get(target.socketId);
    if (targetSocket) {
      targetSocket.emit('ice-candidate', { candidate: data.candidate, senderId: socket.userId });
    }
  });

  // request_reoffer (responder asks initiator to re-offer)
  socket.on('request_reoffer', (data) => {
    const room = activeRooms.get(data && data.room);
    if (!room) return;
    const initiatorUser = room.user1.initiator ? room.user1 : (room.user2.initiator ? room.user2 : null);
    if (!initiatorUser) return;
    const initiatorSocket = io.sockets.sockets.get(initiatorUser.socketId);
    if (initiatorSocket) {
      initiatorSocket.emit('request_reoffer', { room: data.room, requester: socket.userId });
      console.log(`[SERVER] ${socket.userId} requested re-offer in room ${data.room}`);
    }
  });

  // disconnect
  socket.on('disconnect', () => {
    console.log(`[SERVER] Socket disconnected for user ${socket.userId}`);
    // mark token socketId null and schedule cleanup
    for (const [tkn, entry] of tokenToUser.entries()) {
      if (entry.userId === socket.userId) {
        entry.socketId = null;
        entry.lastSeen = Date.now();
        scheduleTokenCleanup(tkn);
        break;
      }
    }
    // notify partner if in room; keep room alive for TTL
    for (const [roomId, room] of activeRooms.entries()) {
      if (room.user1.id === socket.userId || room.user2.id === socket.userId) {
        const other = room.user1.id === socket.userId ? room.user2 : room.user1;
        const otherSocket = io.sockets.sockets.get(other.socketId);
        if (otherSocket) otherSocket.emit('partner_disconnected', { room: roomId, partnerId: socket.userId });
        // schedule cleanup after TTL
        setTimeout(() => cleanupRoomIfBothDisconnected(roomId), ROOM_RECONNECT_TTL_MS + 1000);
        break;
      }
    }
    // cleanup waiting
    cleanupUserFromWaiting(socket.userId);
    // don't decrement userCount here (we count logical users via tokens)
    broadcastUserCount();
  });
});

// periodic status log
setInterval(() => {
  console.log(`[SERVER] status: rooms=${activeRooms.size}, queue=${queue.length}, waiting=${waitingUsers.size}, tokens=${tokenToUser.size}, usersConnected=${userCount}`);
}, 30000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`[SERVER] listening on ${PORT}`));
