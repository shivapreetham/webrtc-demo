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

// Data stores
const waitingUsers = new Map(); // userId -> { socket, socketId, audioEnabled, videoEnabled, joinTime, token }
const queue = []; // FIFO queue of userIds
const activeRooms = new Map(); // roomId -> { user1, user2, created }
const tokenToUser = new Map(); // token -> { userId, socketId, roomId? }
const userConnections = new Map(); // userId -> socketId
const userCount = { count: 0 };

// Helpers
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

const cleanupUser = (userId) => {
  console.log(`[SERVER] Cleaning up user ${userId}`);
  cleanupUserFromWaiting(userId);

  for (const [roomId, roomData] of activeRooms.entries()) {
    if (roomData.user1.id === userId || roomData.user2.id === userId) {
      const otherUser = roomData.user1.id === userId ? roomData.user2 : roomData.user1;
      console.log(`[SERVER] Notifying ${otherUser.id} about ${userId}'s disconnection`);
      const otherSocket = io.sockets.sockets.get(otherUser.socketId);
      if (otherSocket) otherSocket.emit('partner_disconnected');
      activeRooms.delete(roomId);
      for (const [token, ud] of tokenToUser.entries()) {
        if (ud.userId === otherUser.id) { ud.roomId = null; }
      }
      console.log(`[SERVER] Room ${roomId} closed due to disconnection`);
      break;
    }
  }

  userConnections.delete(userId);
};

// find a partner from queue (consumes queue until finds valid partner)
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

io.on('connection', (socket) => {
  const userId = generateId();
  const token = generateToken();

  socket.userId = userId;
  socket.token = token;

  userConnections.set(userId, socket.id);
  tokenToUser.set(token, { userId, socketId: socket.id, roomId: null });

  userCount.count++;
  broadcastUserCount();

  console.log(`[SERVER] User ${userId} connected. Socket: ${socket.id}. Total: ${userCount.count}`);
  socket.emit('welcome', { userId, token });

  socket.on('reconnect_user', (data) => {
    const { token: clientToken } = data || {};
    const entry = tokenToUser.get(clientToken);
    if (entry && entry.userId) {
      entry.socketId = socket.id;
      socket.userId = entry.userId;
      socket.token = clientToken;
      userConnections.set(entry.userId, socket.id);

      if (waitingUsers.has(entry.userId)) {
        const u = waitingUsers.get(entry.userId);
        u.socket = socket;
        u.socketId = socket.id;
        waitingUsers.set(entry.userId, u);
      }

      for (const [roomId, room] of activeRooms.entries()) {
        if (room.user1.id === entry.userId) {
          room.user1.socket = socket; room.user1.socketId = socket.id;
        }
        if (room.user2.id === entry.userId) {
          room.user2.socket = socket; room.user2.socketId = socket.id;
        }
      }

      socket.emit('reconnect_success', { room: entry.roomId || null, userId: entry.userId });
      console.log(`[SERVER] Reconnect successful for ${entry.userId}`);
    } else {
      socket.emit('reconnect_failed');
      console.log(`[SERVER] Reconnect failed for token ${clientToken}`);
    }
  });

  socket.on('find_partner', (data) => {
    const { audioEnabled = true, videoEnabled = true } = data || {};
    console.log(`[SERVER] User ${userId} looking for partner`);

    const alreadyInRoom = Array.from(activeRooms.values()).some(r => r.user1.id === userId || r.user2.id === userId);
    if (alreadyInRoom) { console.log(`[SERVER] User ${userId} already in a room`); return; }
    if (waitingUsers.has(userId)) { console.log(`[SERVER] User ${userId} already waiting`); return; }

    const partner = tryPairWithQueue(userId);

    if (partner) {
      const roomId = generateRoomId();
      console.log(`[SERVER] Pairing ${userId} with ${partner.userId} into room ${roomId}`);

      waitingUsers.delete(partner.userId);
      waitingUsers.delete(userId);

      const myJoinTime = Date.now();
      const partnerJoinTime = partner.userData.joinTime || Date.now();
      const roles = determineInitiator(
        userId, { joinTime: myJoinTime },
        partner.userId, { joinTime: partnerJoinTime }
      );

      const initiatorSocket = roles.initiator === userId ? socket : partner.userData.socket;
      const initiatorSocketId = roles.initiator === userId ? socket.id : partner.userData.socketId;
      const responderSocket = roles.responder === userId ? socket : partner.userData.socket;
      const responderSocketId = roles.responder === userId ? socket.id : partner.userData.socketId;

      const roomData = {
        user1: { id: roles.initiator, socket: initiatorSocket, socketId: initiatorSocketId, initiator: true },
        user2: { id: roles.responder, socket: responderSocket, socketId: responderSocketId, initiator: false },
        created: Date.now()
      };

      activeRooms.set(roomId, roomData);

      for (const [tkn, ud] of tokenToUser.entries()) {
        if (ud.userId === roles.initiator || ud.userId === roles.responder) ud.roomId = roomId;
      }

      if (roomData.user1.socket) {
        roomData.user1.socket.emit('room_assigned', {
          room: roomId, initiator: true, role: 'initiator', partnerId: roles.responder
        });
      }
      if (roomData.user2.socket) {
        roomData.user2.socket.emit('room_assigned', {
          room: roomId, initiator: false, role: 'responder', partnerId: roles.initiator
        });
      }

      console.log(`[SERVER] Room ${roomId} created: ${roles.initiator} (init) & ${roles.responder} (resp)`);
      return;
    }

    // No partner -> add to waiting
    waitingUsers.set(userId, {
      socket,
      socketId: socket.id,
      audioEnabled,
      videoEnabled,
      joinTime: Date.now(),
      token,
    });
    queue.push(userId);
    console.log(`[SERVER] User ${userId} added to waiting queue. Queue len: ${queue.length}`);
  });

  socket.on('join_room', (data) => {
    const { room: roomToJoin, token: clientToken } = data || {};
    console.log(`[SERVER] ${userId} joining room ${roomToJoin}`);

    const room = activeRooms.get(roomToJoin);
    if (!room) { socket.emit('join_failed', { reason: 'no_room' }); return; }

    if (clientToken && tokenToUser.has(clientToken)) {
      const entry = tokenToUser.get(clientToken);
      if (entry.userId === userId) {
        entry.socketId = socket.id;
        userConnections.set(userId, socket.id);
        if (room.user1.id === userId) { room.user1.socket = socket; room.user1.socketId = socket.id; }
        else if (room.user2.id === userId) { room.user2.socket = socket; room.user2.socketId = socket.id; }
      }
    }

    const isUser1 = room.user1.id === userId;
    const isUser2 = room.user2.id === userId;

    if (isUser1 || isUser2) {
      const userData = isUser1 ? room.user1 : room.user2;
      const partnerData = isUser1 ? room.user2 : room.user1;
      socket.emit('room_joined', {
        room: roomToJoin,
        initiator: userData.initiator,
        role: userData.initiator ? 'initiator' : 'responder',
        partnerId: partnerData.id
      });
      console.log(`[SERVER] ${userId} joined room as ${userData.initiator ? 'initiator' : 'responder'}`);
    } else {
      socket.emit('join_failed', { reason: 'not_authorized' });
    }
  });

  socket.on('skip', () => {
    const userRoom = Array.from(activeRooms.entries()).find(([_, r]) => r.user1.id === userId || r.user2.id === userId);
    if (userRoom) {
      const [roomId, roomData] = userRoom;
      const otherUser = roomData.user1.id === userId ? roomData.user2 : roomData.user1;
      console.log(`[SERVER] ${userId} skipping in room ${roomId}`);
      const otherSocket = io.sockets.sockets.get(otherUser.socketId);
      if (otherSocket) otherSocket.emit('partner_skipped');
      activeRooms.delete(roomId);
      for (const [tkn, ud] of tokenToUser.entries()) { if (ud.userId === userId || ud.userId === otherUser.id) ud.roomId = null; }
      return;
    }
    if (waitingUsers.has(userId)) { cleanupUserFromWaiting(userId); console.log(`[SERVER] ${userId} skipped while waiting`); }
  });

  // Signaling relay
  socket.on('offer', (data) => {
    const { room: targetRoomId, offer } = data || {};
    const room = activeRooms.get(targetRoomId); if (!room) return;
    const isUser1 = room.user1.id === userId; const isUser2 = room.user2.id === userId;
    if (!isUser1 && !isUser2) return;
    const targetUser = isUser1 ? room.user2 : room.user1;
    const targetSocket = io.sockets.sockets.get(targetUser.socketId);
    if (targetSocket) { targetSocket.emit('offer', { offer, senderId: userId }); console.log(`[SERVER] Forwarded offer from ${userId} to ${targetUser.id}`); }
  });

  socket.on('answer', (data) => {
    const { room: targetRoomId, answer } = data || {};
    const room = activeRooms.get(targetRoomId); if (!room) return;
    const isUser1 = room.user1.id === userId; const isUser2 = room.user2.id === userId;
    if (!isUser1 && !isUser2) return;
    const targetUser = isUser1 ? room.user2 : room.user1;
    const targetSocket = io.sockets.sockets.get(targetUser.socketId);
    if (targetSocket) { targetSocket.emit('answer', { answer, senderId: userId }); console.log(`[SERVER] Forwarded answer from ${userId} to ${targetUser.id}`); }
  });

  socket.on('ice-candidate', (data) => {
    const { room: targetRoomId, candidate } = data || {};
    const room = activeRooms.get(targetRoomId); if (!room) return;
    const isUser1 = room.user1.id === userId; const isUser2 = room.user2.id === userId;
    if (!isUser1 && !isUser2) return;
    const targetUser = isUser1 ? room.user2 : room.user1;
    const targetSocket = io.sockets.sockets.get(targetUser.socketId);
    if (targetSocket) { targetSocket.emit('ice-candidate', { candidate, senderId: userId }); }
  });

  socket.on('disconnect', () => {
    console.log(`[SERVER] User ${userId} disconnected`);
    cleanupUser(userId);
    if (socket.token && tokenToUser.has(socket.token)) { const u = tokenToUser.get(socket.token); u.socketId = null; }
    userCount.count = Math.max(0, userCount.count - 1);
    broadcastUserCount();
    console.log(`[SERVER] Cleanup complete. Total users: ${userCount.count}`);
  });
});

setInterval(() => {
  const now = Date.now();
  let cleanedRooms = 0;
  for (const [roomId, roomData] of activeRooms.entries()) {
    if (now - roomData.created > 10 * 60 * 1000) {
      console.log(`[SERVER] Cleaning up old room: ${roomId}`);
      activeRooms.delete(roomId);
      cleanedRooms++;
    }
  }
  console.log(`[SERVER] Status - Active rooms: ${activeRooms.size}, Waiting: ${queue.length}, Users: ${userCount.count}, Cleaned: ${cleanedRooms}`);
  if (activeRooms.size > 0) {
    console.log(`[SERVER] Active rooms:`);
    for (const [roomId, roomData] of activeRooms.entries()) {
      console.log(`  - ${roomId}: ${roomData.user1.id} (init) & ${roomData.user2.id} (resp)`);
    }
  }
  if (queue.length > 0) {
    console.log(`[SERVER] Waiting queue: ${queue.join(', ')}`);
  }
}, 30000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`[SERVER] Socket.IO server running on port ${PORT}`));
