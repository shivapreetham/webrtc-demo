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

// Helpers
const generateId = () => crypto.randomBytes(8).toString('hex');
const generateToken = () => crypto.randomBytes(16).toString('hex');

const getUserCount = () => users.size;
const broadcastUserCount = () => io.emit('user_count', { count: getUserCount() });

// Clean up disconnected users
const cleanupUser = (userId) => {
  const user = users.get(userId);
  if (!user) return;

  // Remove from waiting queue
  const queueIndex = waitingQueue.indexOf(userId);
  if (queueIndex > -1) waitingQueue.splice(queueIndex, 1);

  // Handle room cleanup
  if (user.roomId) {
    const room = rooms.get(user.roomId);
    if (room) {
      const partnerId = room.user1Id === userId ? room.user2Id : room.user1Id;
      const partner = users.get(partnerId);
      if (partner && partner.socket) {
        try { partner.socket.emit('partner_disconnected'); } catch(e) {}
        partner.roomId = null;
      }
      rooms.delete(user.roomId);
    }
  }

  users.delete(userId);
  broadcastUserCount();
};

// Create a new room between two users
const createRoom = (user1Id, user2Id) => {
  const roomId = generateId();
  const user1 = users.get(user1Id);
  const user2 = users.get(user2Id);

  if (!user1 || !user2) return null;

  // Remove both from waiting queue
  const idx1 = waitingQueue.indexOf(user1Id);
  const idx2 = waitingQueue.indexOf(user2Id);
  if (idx1 > -1) waitingQueue.splice(idx1, 1);
  if (idx2 > -1) waitingQueue.splice(idx2, 1);

  // Create room
  const room = { user1Id, user2Id, createdAt: Date.now() };
  rooms.set(roomId, room);

  // Update users
  user1.roomId = roomId;
  user2.roomId = roomId;

  // Determine initiator (first user in queue becomes initiator: compare waitingSince)
  const initiator = (user1.waitingSince <= user2.waitingSince) ? user1Id : user2Id;

  // Notify both users
  try {
    user1.socket.emit('room_assigned', {
      roomId,
      partnerId: user2Id,
      isInitiator: initiator === user1Id
    });
  } catch (e) { /* ignore */ }

  try {
    user2.socket.emit('room_assigned', {
      roomId,
      partnerId: user1Id,
      isInitiator: initiator === user2Id
    });
  } catch (e) { /* ignore */ }

  console.log(`Room ${roomId} created: ${user1Id} & ${user2Id}`);
  broadcastUserCount();
  return roomId;
};

app.get('/status', (req, res) => {
  res.json({
    users: users.size,
    waiting: waitingQueue.length,
    rooms: rooms.size
  });
});

io.on('connection', (socket) => {
  let userId = null;
  let token = null;

  console.log('User connected:', socket.id);

  socket.on('init', (data) => {
    // if already initialized for this socket, don't double-init
    if (userId && users.has(userId)) {
      socket.emit('init_success', { userId, token });
      return;
    }

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
    console.log(`User ${userId} initialized`);
  });

  socket.on('find_partner', () => {
    if (!userId || !users.has(userId)) {
      socket.emit('error', { message: 'User not initialized' });
      return;
    }

    const user = users.get(userId);

    // Already in room or waiting
    if (user.roomId || waitingQueue.includes(userId)) {
      return;
    }

    // Try to match with someone in queue
    while (waitingQueue.length > 0) {
      const partnerId = waitingQueue.shift();
      const partner = users.get(partnerId);
      if (!partner || !partner.socket) {
        // stale, skip
        continue;
      }
      // If partner is same as user just skip (shouldn't happen)
      if (partnerId === userId) continue;

      // Create room
      createRoom(partnerId, userId);
      return;
    }

    // Add to waiting queue
    user.waitingSince = Date.now();
    waitingQueue.push(userId);
    socket.emit('searching');
    console.log(`User ${userId} added to queue. Queue length: ${waitingQueue.length}`);
    broadcastUserCount();
  });

  socket.on('join_room', (data) => {
    if (!userId || !data.roomId) return;

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

    socket.emit('room_joined', {
      roomId: data.roomId,
      partnerId,
      isInitiator
    });
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
          try { partner.socket.emit('partner_skipped'); } catch(e) {}
          partner.roomId = null;
        }
        rooms.delete(user.roomId);
        user.roomId = null;
      }
    }

    // Remove from queue
    const queueIndex = waitingQueue.indexOf(userId);
    if (queueIndex > -1) waitingQueue.splice(queueIndex, 1);

    user.waitingSince = null;
    broadcastUserCount();
  });

  // WebRTC Signaling
  socket.on('offer', (data) => {
    if (!userId || !data.roomId || !data.offer) return;

    const room = rooms.get(data.roomId);
    if (!room) return;

    const partnerId = room.user1Id === userId ? room.user2Id : room.user1Id;
    const partner = users.get(partnerId);

    if (partner && partner.socket) {
      try {
        partner.socket.emit('offer', {
          offer: data.offer,
          from: userId
        });
      } catch (e) { /* ignore */ }
    }
  });

  socket.on('answer', (data) => {
    if (!userId || !data.roomId || !data.answer) return;

    const room = rooms.get(data.roomId);
    if (!room) return;

    const partnerId = room.user1Id === userId ? room.user2Id : room.user1Id;
    const partner = users.get(partnerId);

    if (partner && partner.socket) {
      try {
        partner.socket.emit('answer', {
          answer: data.answer,
          from: userId
        });
      } catch (e) { /* ignore */ }
    }
  });

  socket.on('ice_candidate', (data) => {
    if (!userId || !data.roomId || !data.candidate) return;

    const room = rooms.get(data.roomId);
    if (!room) return;

    const partnerId = room.user1Id === userId ? room.user2Id : room.user1Id;
    const partner = users.get(partnerId);

    if (partner && partner.socket) {
      try {
        partner.socket.emit('ice_candidate', {
          candidate: data.candidate,
          from: userId
        });
      } catch (e) { /* ignore */ }
    }
  });

  // Chat messages
  socket.on('chat_message', (data) => {
    if (!userId || !data.roomId || !data.message) return;

    const room = rooms.get(data.roomId);
    if (!room) return;

    const partnerId = room.user1Id === userId ? room.user2Id : room.user1Id;
    const partner = users.get(partnerId);

    if (partner && partner.socket) {
      try {
        partner.socket.emit('chat_message', {
          message: data.message.trim().substring(0, 500),
          from: userId,
          timestamp: Date.now()
        });
      } catch (e) { /* ignore */ }
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    if (userId) cleanupUser(userId);
  });
});

// Cleanup old rooms every 5 minutes
setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes

  for (const [roomId, room] of rooms.entries()) {
    if (now - room.createdAt > maxAge) {
      rooms.delete(roomId);
      console.log(`Cleaned up old room: ${roomId}`);
    }
  }
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
