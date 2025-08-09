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

// In-memory stores
const users = new Map(); // userId -> { socket, token, roomId, waitingSince }
const waitingQueue = []; // array of userIds waiting for match
const rooms = new Map(); // roomId -> { user1Id, user2Id, createdAt }

const generateId = () => crypto.randomBytes(8).toString('hex');
const generateToken = () => crypto.randomBytes(16).toString('hex');

const getUserCount = () => users.size;
const broadcastUserCount = () => io.emit('user_count', { count: getUserCount() });

const cleanupUser = (userId) => {
  const user = users.get(userId);
  if (!user) return;

  const qi = waitingQueue.indexOf(userId);
  if (qi > -1) waitingQueue.splice(qi, 1);

  if (user.roomId) {
    const room = rooms.get(user.roomId);
    if (room) {
      const partnerId = room.user1Id === userId ? room.user2Id : room.user1Id;
      const partner = users.get(partnerId);
      if (partner && partner.socket) {
        partner.socket.emit('partner_disconnected');
        partner.roomId = null;
      }
      rooms.delete(user.roomId);
    }
  }
  users.delete(userId);
  broadcastUserCount();
};

const createRoom = (user1Id, user2Id) => {
  const roomId = generateId();
  const user1 = users.get(user1Id);
  const user2 = users.get(user2Id);
  if (!user1 || !user2) return null;

  const i1 = waitingQueue.indexOf(user1Id); if (i1 > -1) waitingQueue.splice(i1, 1);
  const i2 = waitingQueue.indexOf(user2Id); if (i2 > -1) waitingQueue.splice(i2, 1);

  const room = { user1Id, user2Id, createdAt: Date.now() };
  rooms.set(roomId, room);
  user1.roomId = roomId;
  user2.roomId = roomId;

  const initiator = (user1.waitingSince <= user2.waitingSince) ? user1Id : user2Id;

  user1.socket.emit('room_assigned', {
    roomId, partnerId: user2Id, isInitiator: initiator === user1Id
  });
  user2.socket.emit('room_assigned', {
    roomId, partnerId: user1Id, isInitiator: initiator === user2Id
  });

  console.log(`Room ${roomId} created: ${user1Id} <-> ${user2Id}`);
  broadcastUserCount();
  return roomId;
};

app.get('/status', (req, res) => {
  res.json({ users: users.size, waiting: waitingQueue.length, rooms: rooms.size });
});

io.on('connection', (socket) => {
  let userId = null;
  let token = null;

  console.log('User connected:', socket.id);

  socket.on('init', () => {
    userId = generateId();
    token = generateToken();
    users.set(userId, {
      socket,
      token,
      roomId: null,
      waitingSince: null
    });

    socket.emit('init_success', { userId, token });
    broadcastUserCount();
    console.log(`User ${userId} initialized (socket ${socket.id})`);
  });

  socket.on('find_partner', () => {
    if (!userId || !users.has(userId)) {
      socket.emit('error', { message: 'User not initialized' });
      return;
    }

    const user = users.get(userId);
    if (!user) return;

    if (user.roomId || waitingQueue.includes(userId)) return;

    while (waitingQueue.length > 0) {
      const partnerId = waitingQueue.shift();
      if (!users.has(partnerId)) continue;
      if (partnerId === userId) continue;
      createRoom(partnerId, userId);
      return;
    }

    user.waitingSince = Date.now();
    waitingQueue.push(userId);
    socket.emit('searching');
    broadcastUserCount();
    console.log(`User ${userId} added to waiting queue. queue length: ${waitingQueue.length}`);
  });

  socket.on('join_room', (data) => {
    if (!userId || !data || !data.roomId) return;
    const room = rooms.get(data.roomId);
    if (!room) {
      socket.emit('room_error', { message: 'Room not found' });
      return;
    }
    if (room.user1Id !== userId && room.user2Id !== userId) {
      socket.emit('room_error', { message: 'Not authorized for this room' });
      return;
    }
    const partnerId = room.user1Id === userId ? room.user2Id : room.user1Id;
    const isInitiator = room.user1Id === userId;
    socket.emit('room_joined', { roomId: data.roomId, partnerId, isInitiator });
  });

  socket.on('skip', () => {
    if (!userId) return;
    const user = users.get(userId);
    if (!user) return;

    if (user.roomId) {
      const room = rooms.get(user.roomId);
      if (room) {
        const partnerId = room.user1Id === userId ? room.user2Id : room.user1Id;
        const partner = users.get(partnerId);
        if (partner && partner.socket) {
          partner.socket.emit('partner_skipped');
          partner.roomId = null;
        }
        rooms.delete(user.roomId);
        user.roomId = null;
      }
    }

    const qidx = waitingQueue.indexOf(userId);
    if (qidx > -1) waitingQueue.splice(qidx, 1);

    user.waitingSince = null;
    broadcastUserCount();
  });

  socket.on('offer', (data) => {
    if (!userId || !data || !data.roomId || !data.offer) return;
    const room = rooms.get(data.roomId);
    if (!room) return;
    const partnerId = room.user1Id === userId ? room.user2Id : room.user1Id;
    const partner = users.get(partnerId);
    if (partner && partner.socket) {
      partner.socket.emit('offer', { offer: data.offer, from: userId });
    }
  });

  socket.on('answer', (data) => {
    if (!userId || !data || !data.roomId || !data.answer) return;
    const room = rooms.get(data.roomId);
    if (!room) return;
    const partnerId = room.user1Id === userId ? room.user2Id : room.user1Id;
    const partner = users.get(partnerId);
    if (partner && partner.socket) {
      partner.socket.emit('answer', { answer: data.answer, from: userId });
    }
  });

  socket.on('ice_candidate', (data) => {
    if (!userId || !data || !data.roomId || !data.candidate) return;
    const room = rooms.get(data.roomId);
    if (!room) return;
    const partnerId = room.user1Id === userId ? room.user2Id : room.user1Id;
    const partner = users.get(partnerId);
    if (partner && partner.socket) {
      partner.socket.emit('ice_candidate', { candidate: data.candidate, from: userId });
    }
  });

  socket.on('chat_message', (data) => {
    if (!userId || !data || !data.roomId || !data.message) return;
    const room = rooms.get(data.roomId);
    if (!room) return;
    const partnerId = room.user1Id === userId ? room.user2Id : room.user1Id;
    const partner = users.get(partnerId);
    if (partner && partner.socket) {
      partner.socket.emit('chat_message', {
        message: data.message.trim().substring(0, 500),
        from: userId,
        timestamp: Date.now()
      });
    }
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id, 'userId', userId);
    if (userId) cleanupUser(userId);
  });
});

setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000;
  for (const [roomId, room] of rooms.entries()) {
    if (now - room.createdAt > maxAge) {
      rooms.delete(roomId);
      console.log(`Cleaned up old room: ${roomId}`);
    }
  }
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));