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
const userCount = { count: 0 };

// Config
const ROOM_TTL_MS = 2 * 60 * 1000; // keep room for 2 minutes if someone disconnects

// --- Helpers ---
const generateId = () => Math.random().toString(36).substr(2, 9);
const generateRoomId = () => Math.random().toString(36).substr(2, 12);
const generateToken = () => crypto.randomBytes(16).toString('hex');

const determineInitiator = (user1Id, user1Data, user2Id, user2Data) => {
  if (user1Data.joinTime < user2Data.joinTime) return { initiator: user1Id, responder: user2Id };
  if (user2Data.joinTime < user1Data.joinTime) return { initiator: user2Id, responder: user1Id };
  return user1Id < user2Id ? { initiator: user1Id, responder: user2Id } : { initiator: user2Id, responder: user1Id };
};

const broadcastUserCount = () => io.emit('user_count', { count: userCount.count });

const cleanupUserFromWaiting = (userId) => {
  if (waitingUsers.has(userId)) waitingUsers.delete(userId);
  const idx = queue.indexOf(userId);
  if (idx !== -1) queue.splice(idx, 1);
};

const scheduleTokenCleanup = (token) => {
  const entry = tokenToUser.get(token);
  if (!entry) return;
  // If already scheduled, ignore
  if (entry.cleanupTimer) return;
  entry.cleanupTimer = setTimeout(() => {
    // If still disconnected and not in room, remove token
    const e = tokenToUser.get(token);
    if (e && (!e.socketId) && !e.roomId) {
      tokenToUser.delete(token);
      console.log(`[SERVER] Token ${token} expired and removed`);
    } else if (e && (!e.socketId) && e.roomId) {
      // If room exists but both disconnected, server cleanup handled by room TTL loop
      console.log(`[SERVER] Token ${token} disconnected but room still exists`);
    }
    if (e) e.cleanupTimer = null;
  }, ROOM_TTL_MS);
};

const cancelTokenCleanup = (token) => {
  const entry = tokenToUser.get(token);
  if (entry && entry.cleanupTimer) {
    clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = null;
  }
};

const cleanupRoomIfEmpty = (roomId) => {
  const room = activeRooms.get(roomId);
  if (!room) return;
  const u1alive = io.sockets.sockets.get(room.user1.socketId);
  const u2alive = io.sockets.sockets.get(room.user2.socketId);
  // if both gone -> remove room
  if (!u1alive && !u2alive) {
    activeRooms.delete(roomId);
    console.log(`[SERVER] Room ${roomId} removed (both peers disconnected)`);
    // update tokenToUser roomId -> null
    for (const [token, entry] of tokenToUser.entries()) {
      if (entry.userId === room.user1.id || entry.userId === room.user2.id) entry.roomId = null;
    }
  }
};

// pairing helper that consumes queue until finds a live waiting user
const tryPairWithQueue = (requestingUserId) => {
  while (queue.length > 0) {
    const candidateId = queue.shift();
    if (!candidateId || candidateId === requestingUserId) continue;
    if (!waitingUsers.has(candidateId)) continue;
    const candidateData = waitingUsers.get(candidateId);
    const candidateSocketAlive = candidateData.socket && io.sockets.sockets.get(candidateData.socketId);
    if (!candidateSocketAlive) {
      waitingUsers.delete(candidateId);
      continue;
    }
    return { userId: candidateId, userData: candidateData };
  }
  return null;
};

// --- Connection handling ---
io.on('connection', (socket) => {
  // Prefer client-provided token in auth for stable identity
  const clientToken = socket.handshake.auth && socket.handshake.auth.token;
  let userId;
  let token;

  if (clientToken && tokenToUser.has(clientToken)) {
    // Re-attach to existing identity
    const entry = tokenToUser.get(clientToken);
    token = clientToken;
    userId = entry.userId;
    entry.socketId = socket.id;
    entry.lastSeen = Date.now();
    cancelTokenCleanup(clientToken);
    console.log(`[SERVER] Socket reattached to existing token ${token} -> user ${userId}`);
    socket.userId = userId;
    socket.token = token;
    userConnections.set(userId, socket.id);
    socket.emit('reconnect_success', { room: entry.roomId || null, userId });
    // If user had a room, update room socket references and inform partner
    if (entry.roomId && activeRooms.has(entry.roomId)) {
      const room = activeRooms.get(entry.roomId);
      // update whichever user slot belongs to this userId
      if (room.user1.id === userId) {
        room.user1.socket = socket;
        room.user1.socketId = socket.id;
      } else if (room.user2.id === userId) {
        room.user2.socket = socket;
        room.user2.socketId = socket.id;
      }
      // Notify partner if partner is connected
      const partner = room.user1.id === userId ? room.user2 : room.user1;
      const partnerSocket = io.sockets.sockets.get(partner.socketId);
      if (partnerSocket) {
        partnerSocket.emit('partner_reconnected', { room: entry.roomId, partnerId: userId });
      }
    }
    // update user counters? not increasing because it is reattach
  } else {
    // Brand new user
    userId = generateId();
    token = generateToken();
    socket.userId = userId;
    socket.token = token;
    tokenToUser.set(token, { userId, socketId: socket.id, roomId: null, cleanupTimer: null, lastSeen: Date.now() });
    userConnections.set(userId, socket.id);
    userCount.count++;
    broadcastUserCount();
    console.log(`[SERVER] New user ${userId} connected - token ${token}. Total: ${userCount.count}`);
    socket.emit('welcome', { userId, token });
  }

  // --- Handle manual reconnect_user as well (keep for backward compatibility) ---
  socket.on('reconnect_user', (data) => {
    const { token: clientToken2 } = data || {};
    if (!clientToken2) { socket.emit('reconnect_failed'); return; }
    const entry = tokenToUser.get(clientToken2);
    if (entry && entry.userId) {
      entry.socketId = socket.id;
      socket.userId = entry.userId;
      socket.token = clientToken2;
      userConnections.set(entry.userId, socket.id);
      cancelTokenCleanup(clientToken2);

      // update waiting/room socket refs
      if (waitingUsers.has(entry.userId)) {
        const u = waitingUsers.get(entry.userId);
        u.socket = socket; u.socketId = socket.id; waitingUsers.set(entry.userId, u);
      }
      for (const [roomId, room] of activeRooms.entries()) {
        if (room.user1.id === entry.userId) { room.user1.socket = socket; room.user1.socketId = socket.id; }
        if (room.user2.id === entry.userId) { room.user2.socket = socket; room.user2.socketId = socket.id; }
      }

      socket.emit('reconnect_success', { room: entry.roomId || null, userId: entry.userId });
      console.log(`[SERVER] Reconnect successful for ${entry.userId}`);
      // notify partner if in room
      if (entry.roomId && activeRooms.has(entry.roomId)) {
        const room = activeRooms.get(entry.roomId);
        const partner = room.user1.id === entry.userId ? room.user2 : room.user1;
        const partnerSocket = io.sockets.sockets.get(partner.socketId);
        if (partnerSocket) partnerSocket.emit('partner_reconnected', { room: entry.roomId, partnerId: entry.userId });
      }
    } else {
      socket.emit('reconnect_failed');
      console.log(`[SERVER] Reconnect failed for token ${clientToken2}`);
    }
  });

  // --- find_partner ---
  socket.on('find_partner', (data) => {
    const { audioEnabled = true, videoEnabled = true } = data || {};
    console.log(`[SERVER] User ${socket.userId} looking for partner`);

    const userIdLocal = socket.userId;

    // Do not allow pairing if user already in a room or waiting
    const alreadyInRoom = Array.from(activeRooms.values()).some(r => r.user1.id === userIdLocal || r.user2.id === userIdLocal);
    if (alreadyInRoom) { console.log(`[SERVER] User ${userIdLocal} already in a room`); return; }
    if (waitingUsers.has(userIdLocal)) { console.log(`[SERVER] User ${userIdLocal} already waiting`); return; }

    // Attempt to pair from queue
    const partner = tryPairWithQueue(userIdLocal);
    if (partner) {
      const roomId = generateRoomId();
      console.log(`[SERVER] Pairing ${userIdLocal} with ${partner.userId} into room ${roomId}`);

      waitingUsers.delete(partner.userId);
      waitingUsers.delete(userIdLocal);

      const myJoinTime = Date.now();
      const partnerJoinTime = partner.userData.joinTime || Date.now();
      const roles = determineInitiator(
        userIdLocal, { joinTime: myJoinTime },
        partner.userId, { joinTime: partnerJoinTime }
      );

      const initiatorSocket = roles.initiator === userIdLocal ? socket : partner.userData.socket;
      const initiatorSocketId = roles.initiator === userIdLocal ? socket.id : partner.userData.socketId;
      const responderSocket = roles.responder === userIdLocal ? socket : partner.userData.socket;
      const responderSocketId = roles.responder === userIdLocal ? socket.id : partner.userData.socketId;

      const roomData = {
        user1: { id: roles.initiator, socket: initiatorSocket, socketId: initiatorSocketId, initiator: true },
        user2: { id: roles.responder, socket: responderSocket, socketId: responderSocketId, initiator: false },
        created: Date.now()
      };

      activeRooms.set(roomId, roomData);

      // update tokenToUser entries to reference the new room
      for (const [tkn, ud] of tokenToUser.entries()) {
        if (ud.userId === roles.initiator || ud.userId === roles.responder) ud.roomId = roomId;
      }

      if (roomData.user1.socket) {
        roomData.user1.socket.emit('room_assigned', { room: roomId, initiator: true, role: 'initiator', partnerId: roles.responder });
      }
      if (roomData.user2.socket) {
        roomData.user2.socket.emit('room_assigned', { room: roomId, initiator: false, role: 'responder', partnerId: roles.initiator });
      }

      console.log(`[SERVER] Room ${roomId} created: ${roles.initiator} (init) & ${roles.responder} (resp)`);
      return;
    }

    // otherwise add to waiting queue
    waitingUsers.set(userIdLocal, { socket, socketId: socket.id, audioEnabled, videoEnabled, joinTime: Date.now(), token: socket.token });
    queue.push(userIdLocal);
    console.log(`[SERVER] User ${userIdLocal} added to waiting queue. Queue len: ${queue.length}`);
  });

  // --- join_room ---
  socket.on('join_room', (data) => {
    const { room: roomToJoin } = data || {};
    console.log(`[SERVER] ${socket.userId} joining room ${roomToJoin}`);
    const room = activeRooms.get(roomToJoin);
    if (!room) { socket.emit('join_failed', { reason: 'no_room' }); return; }

    // ensure user is authorized for this room (their userId must match)
    const isUser1 = room.user1.id === socket.userId;
    const isUser2 = room.user2.id === socket.userId;
    if (isUser1 || isUser2) {
      // update socket references
      if (isUser1) { room.user1.socket = socket; room.user1.socketId = socket.id; }
      if (isUser2) { room.user2.socket = socket; room.user2.socketId = socket.id; }

      socket.emit('room_joined', {
        room: roomToJoin,
        initiator: isUser1 ? room.user1.initiator : room.user2.initiator,
        role: (isUser1 ? room.user1.initiator : room.user2.initiator) ? 'initiator' : 'responder',
        partnerId: isUser1 ? room.user2.id : room.user1.id
      });

      console.log(`[SERVER] ${socket.userId} joined room ${roomToJoin} as ${isUser1 ? (room.user1.initiator ? 'initiator' : 'responder') : (room.user2.initiator ? 'initiator' : 'responder')}`);
    } else {
      socket.emit('join_failed', { reason: 'not_authorized' });
    }
  });

  // --- skip ---
  socket.on('skip', () => {
    // if user is in active room, notify partner and remove room
    const userRoom = Array.from(activeRooms.entries()).find(([_, r]) => r.user1.id === socket.userId || r.user2.id === socket.userId);
    if (userRoom) {
      const [roomId, roomData] = userRoom;
      const otherUser = roomData.user1.id === socket.userId ? roomData.user2 : roomData.user1;
      console.log(`[SERVER] ${socket.userId} skipping in room ${roomId}`);
      const otherSocket = io.sockets.sockets.get(otherUser.socketId);
      if (otherSocket) otherSocket.emit('partner_skipped');
      activeRooms.delete(roomId);
      for (const [tkn, ud] of tokenToUser.entries()) {
        if (ud.userId === socket.userId || ud.userId === otherUser.id) ud.roomId = null;
      }
      return;
    }

    // if waiting, remove from waiting
    if (waitingUsers.has(socket.userId)) { cleanupUserFromWaiting(socket.userId); console.log(`[SERVER] ${socket.userId} skipped while waiting`); }
  });

  // --- signaling relays ---
  socket.on('offer', (data) => {
    const { room: targetRoomId, offer } = data || {};
    const room = activeRooms.get(targetRoomId);
    if (!room) return;
    const isUser1 = room.user1.id === socket.userId;
    const isUser2 = room.user2.id === socket.userId;
    if (!isUser1 && !isUser2) return;
    const targetUser = isUser1 ? room.user2 : room.user1;
    const targetSocket = io.sockets.sockets.get(targetUser.socketId);
    if (targetSocket) {
      targetSocket.emit('offer', { offer, senderId: socket.userId });
      console.log(`[SERVER] Forwarded offer from ${socket.userId} to ${targetUser.id}`);
    }
  });

  socket.on('answer', (data) => {
    const { room: targetRoomId, answer } = data || {};
    const room = activeRooms.get(targetRoomId);
    if (!room) return;
    const isUser1 = room.user1.id === socket.userId;
    const isUser2 = room.user2.id === socket.userId;
    if (!isUser1 && !isUser2) return;
    const targetUser = isUser1 ? room.user2 : room.user1;
    const targetSocket = io.sockets.sockets.get(targetUser.socketId);
    if (targetSocket) {
      targetSocket.emit('answer', { answer, senderId: socket.userId });
      console.log(`[SERVER] Forwarded answer from ${socket.userId} to ${targetUser.id}`);
    }
  });

  socket.on('ice-candidate', (data) => {
    const { room: targetRoomId, candidate } = data || {};
    const room = activeRooms.get(targetRoomId);
    if (!room) return;
    const isUser1 = room.user1.id === socket.userId;
    const isUser2 = room.user2.id === socket.userId;
    if (!isUser1 && !isUser2) return;
    const targetUser = isUser1 ? room.user2 : room.user1;
    const targetSocket = io.sockets.sockets.get(targetUser.socketId);
    if (targetSocket) {
      targetSocket.emit('ice-candidate', { candidate, senderId: socket.userId });
    }
  });

  // --- disconnect handling ---
  socket.on('disconnect', () => {
    const uid = socket.userId;
    console.log(`[SERVER] Socket disconnected for user ${uid}`);
    // mark token mapping socketId = null and schedule cleanup
    for (const [tkn, entry] of tokenToUser.entries()) {
      if (entry.userId === uid) {
        entry.socketId = null;
        entry.lastSeen = Date.now();
        scheduleTokenCleanup(tkn);
        break;
      }
    }

    // do not immediately remove from room - keep for ROOM_TTL_MS to allow reconnect
    // notify partner that this user disconnected
    for (const [roomId, roomData] of activeRooms.entries()) {
      if (roomData.user1.id === uid || roomData.user2.id === uid) {
        const otherUser = roomData.user1.id === uid ? roomData.user2 : roomData.user1;
        const otherSocket = io.sockets.sockets.get(otherUser.socketId);
        if (otherSocket) otherSocket.emit('partner_disconnected', { room: roomId, partnerId: uid });
        // schedule room cleanup after TTL if both disconnected
        setTimeout(() => cleanupRoomIfEmpty(roomId), ROOM_TTL_MS + 1000);
        break;
      }
    }

    // remove from waiting queue
    cleanupUserFromWaiting(uid);

    // decrease count only if tokenToUser doesn't have a live socket (i.e., truly gone)
    userCount.count = Math.max(0, userCount.count - 0); // keep unchanged because we keep user identity
    broadcastUserCount();
  });

}); // io.on('connection')


// periodic cleanup & logging
setInterval(() => {
  const now = Date.now();
  let cleanedRooms = 0;
  for (const [roomId, roomData] of activeRooms.entries()) {
    if (now - roomData.created > 30 * 60 * 1000) { // longer hard cap for zombie rooms
      activeRooms.delete(roomId);
      cleanedRooms++;
    }
  }
  console.log(`[SERVER] Status - Active rooms: ${activeRooms.size}, Waiting queue: ${queue.length}, Tokens: ${tokenToUser.size}`);
  if (queue.length > 0) console.log(`[SERVER] Queue: ${queue.join(', ')}`);
}, 30000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`[SERVER] Socket.IO server running on port ${PORT}`));
