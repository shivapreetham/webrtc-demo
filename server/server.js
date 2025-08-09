const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
  cors: { 
    origin: process.env.NODE_ENV === 'production' ? false : '*', 
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
});

// In-memory stores
const users = new Map(); // userId -> { socket, token, roomId, waitingSince, socketId }
const waitingQueue = []; // array of userIds waiting for match
const rooms = new Map(); // roomId -> { user1Id, user2Id, createdAt }

const generateId = () => crypto.randomBytes(8).toString('hex');
const generateToken = () => crypto.randomBytes(16).toString('hex');

const getUserCount = () => users.size;
const broadcastUserCount = () => {
  const count = getUserCount();
  console.log(`Broadcasting user count: ${count}`);
  io.emit('user_count', { count });
};

const cleanupUser = (userId) => {
  console.log(`Cleaning up user: ${userId}`);
  const user = users.get(userId);
  if (!user) return;

  // Remove from waiting queue
  const queueIndex = waitingQueue.indexOf(userId);
  if (queueIndex > -1) {
    waitingQueue.splice(queueIndex, 1);
    console.log(`Removed ${userId} from waiting queue. Queue length: ${waitingQueue.length}`);
  }

  // Handle room cleanup
  if (user.roomId) {
    const room = rooms.get(user.roomId);
    if (room) {
      const partnerId = room.user1Id === userId ? room.user2Id : room.user1Id;
      const partner = users.get(partnerId);
      if (partner && partner.socket && partner.socket.connected) {
        console.log(`Notifying partner ${partnerId} of disconnection`);
        partner.socket.emit('partner_disconnected');
        partner.roomId = null;
      }
      rooms.delete(user.roomId);
      console.log(`Deleted room: ${user.roomId}`);
    }
  }
  
  users.delete(userId);
  broadcastUserCount();
};

const createRoom = (user1Id, user2Id) => {
  const roomId = generateId();
  const user1 = users.get(user1Id);
  const user2 = users.get(user2Id);
  
  if (!user1 || !user2) {
    console.log(`Cannot create room: user1=${!!user1}, user2=${!!user2}`);
    return null;
  }

  if (!user1.socket || !user1.socket.connected || !user2.socket || !user2.socket.connected) {
    console.log(`Cannot create room: users not properly connected`);
    return null;
  }

  // Remove from waiting queue
  const i1 = waitingQueue.indexOf(user1Id);
  if (i1 > -1) waitingQueue.splice(i1, 1);
  const i2 = waitingQueue.indexOf(user2Id);
  if (i2 > -1) waitingQueue.splice(i2, 1);

  const room = { user1Id, user2Id, createdAt: Date.now() };
  rooms.set(roomId, room);
  user1.roomId = roomId;
  user2.roomId = roomId;

  // Determine initiator (whoever was waiting longer)
  const initiator = user1.waitingSince && user2.waitingSince && user1.waitingSince <= user2.waitingSince ? user1Id : user2Id;

  const user1Data = {
    roomId,
    partnerId: user2Id,
    isInitiator: initiator === user1Id,
  };

  const user2Data = {
    roomId,
    partnerId: user1Id,
    isInitiator: initiator === user2Id,
  };

  console.log(`Creating room ${roomId}: ${user1Id} <-> ${user2Id}, initiator: ${initiator}`);

  user1.socket.emit('room_assigned', user1Data);
  user2.socket.emit('room_assigned', user2Data);

  broadcastUserCount();
  return roomId;
};

// Middleware for parsing JSON
app.use(express.json());

// Health check endpoint
app.get('/status', (_req, res) => {
  res.json({ 
    users: users.size, 
    waiting: waitingQueue.length, 
    rooms: rooms.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Root endpoint
app.get('/', (_req, res) => {
  res.json({ message: 'Omegle-like server is running', status: 'ok' });
});

io.on('connection', (socket) => {
  let userId = null;
  let token = null;

  console.log(`New connection: ${socket.id}`);

  // Initialize user
  socket.on('init', () => {
    try {
      userId = generateId();
      token = generateToken();
      
      users.set(userId, {
        socket,
        token,
        roomId: null,
        waitingSince: null,
        socketId: socket.id,
      });

      socket.emit('init_success', { userId, token });
      broadcastUserCount();
      console.log(`User ${userId} initialized (socket ${socket.id})`);
    } catch (error) {
      console.error('Error during init:', error);
      socket.emit('error', { message: 'Initialization failed' });
    }
  });

  // Find partner
  socket.on('find_partner', () => {
    try {
      if (!userId || !users.has(userId)) {
        socket.emit('error', { message: 'User not initialized' });
        return;
      }

      const user = users.get(userId);
      if (!user || !user.socket || !user.socket.connected) {
        socket.emit('error', { message: 'User connection invalid' });
        return;
      }

      // Check if already in room or waiting
      if (user.roomId) {
        console.log(`User ${userId} already in room ${user.roomId}`);
        return;
      }

      if (waitingQueue.includes(userId)) {
        console.log(`User ${userId} already in waiting queue`);
        return;
      }

      // Try to match with someone in the queue
      let matched = false;
      while (waitingQueue.length > 0 && !matched) {
        const partnerId = waitingQueue.shift();
        
        // Validate partner
        if (!users.has(partnerId) || partnerId === userId) {
          console.log(`Invalid partner ${partnerId}, continuing search...`);
          continue;
        }

        const partner = users.get(partnerId);
        if (!partner || !partner.socket || !partner.socket.connected) {
          console.log(`Partner ${partnerId} not properly connected, cleaning up...`);
          users.delete(partnerId);
          continue;
        }

        // Create room
        const roomId = createRoom(partnerId, userId);
        if (roomId) {
          matched = true;
          console.log(`Matched ${userId} with ${partnerId} in room ${roomId}`);
        }
      }

      if (!matched) {
        // Add to waiting queue
        user.waitingSince = Date.now();
        waitingQueue.push(userId);
        socket.emit('searching');
        broadcastUserCount();
        console.log(`User ${userId} added to waiting queue. Queue length: ${waitingQueue.length}`);
      }
    } catch (error) {
      console.error('Error in find_partner:', error);
      socket.emit('error', { message: 'Failed to find partner' });
    }
  });

  // Join room (for validation)
  socket.on('join_room', (data) => {
    try {
      if (!userId || !data || !data.roomId) {
        socket.emit('room_error', { message: 'Invalid join room request' });
        return;
      }

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

      console.log(`User ${userId} joined room ${data.roomId}`);
    } catch (error) {
      console.error('Error in join_room:', error);
      socket.emit('room_error', { message: 'Failed to join room' });
    }
  });

  // Skip/leave current connection
  socket.on('skip', () => {
    try {
      if (!userId) return;
      
      const user = users.get(userId);
      if (!user) return;

      console.log(`User ${userId} skipping...`);

      // Handle room skip
      if (user.roomId) {
        const room = rooms.get(user.roomId);
        if (room) {
          const partnerId = room.user1Id === userId ? room.user2Id : room.user1Id;
          const partner = users.get(partnerId);
          if (partner && partner.socket && partner.socket.connected) {
            partner.socket.emit('partner_skipped');
            partner.roomId = null;
          }
          rooms.delete(user.roomId);
          console.log(`Room ${user.roomId} deleted due to skip`);
        }
        user.roomId = null;
      }

      // Remove from waiting queue
      const queueIndex = waitingQueue.indexOf(userId);
      if (queueIndex > -1) {
        waitingQueue.splice(queueIndex, 1);
        console.log(`Removed ${userId} from waiting queue due to skip`);
      }

      user.waitingSince = null;
      broadcastUserCount();
    } catch (error) {
      console.error('Error in skip:', error);
    }
  });

  // WebRTC signaling - Offer
  socket.on('offer', (data) => {
    try {
      if (!userId || !data || !data.roomId || !data.offer) return;
      
      const room = rooms.get(data.roomId);
      if (!room) {
        console.log(`Offer: Room ${data.roomId} not found`);
        return;
      }
      
      const partnerId = room.user1Id === userId ? room.user2Id : room.user1Id;
      const partner = users.get(partnerId);
      
      if (partner && partner.socket && partner.socket.connected) {
        partner.socket.emit('offer', { offer: data.offer, from: userId });
        console.log(`Forwarded offer from ${userId} to ${partnerId}`);
      } else {
        console.log(`Partner ${partnerId} not available for offer`);
      }
    } catch (error) {
      console.error('Error handling offer:', error);
    }
  });

  // WebRTC signaling - Answer
  socket.on('answer', (data) => {
    try {
      if (!userId || !data || !data.roomId || !data.answer) return;
      
      const room = rooms.get(data.roomId);
      if (!room) {
        console.log(`Answer: Room ${data.roomId} not found`);
        return;
      }
      
      const partnerId = room.user1Id === userId ? room.user2Id : room.user1Id;
      const partner = users.get(partnerId);
      
      if (partner && partner.socket && partner.socket.connected) {
        partner.socket.emit('answer', { answer: data.answer, from: userId });
        console.log(`Forwarded answer from ${userId} to ${partnerId}`);
      } else {
        console.log(`Partner ${partnerId} not available for answer`);
      }
    } catch (error) {
      console.error('Error handling answer:', error);
    }
  });

  // WebRTC signaling - ICE Candidate
  socket.on('ice_candidate', (data) => {
    try {
      if (!userId || !data || !data.roomId || !data.candidate) return;
      
      const room = rooms.get(data.roomId);
      if (!room) return;
      
      const partnerId = room.user1Id === userId ? room.user2Id : room.user1Id;
      const partner = users.get(partnerId);
      
      if (partner && partner.socket && partner.socket.connected) {
        partner.socket.emit('ice_candidate', { candidate: data.candidate, from: userId });
      }
    } catch (error) {
      console.error('Error handling ICE candidate:', error);
    }
  });

  // Chat message
  socket.on('chat_message', (data) => {
    try {
      if (!userId || !data || !data.roomId || !data.message) return;
      
      const room = rooms.get(data.roomId);
      if (!room) return;
      
      const partnerId = room.user1Id === userId ? room.user2Id : room.user1Id;
      const partner = users.get(partnerId);
      
      if (partner && partner.socket && partner.socket.connected) {
        const sanitizedMessage = data.message.toString().trim().substring(0, 500);
        partner.socket.emit('chat_message', {
          message: sanitizedMessage,
          from: userId,
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      console.error('Error handling chat message:', error);
    }
  });

  // Handle disconnect
  socket.on('disconnect', (reason) => {
    console.log(`Socket disconnected: ${socket.id}, userId: ${userId}, reason: ${reason}`);
    if (userId) {
      cleanupUser(userId);
    }
  });

  // Handle errors
  socket.on('error', (error) => {
    console.error(`Socket error from ${socket.id}:`, error);
  });
});

// Cleanup old rooms periodically
setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes
  let cleanedCount = 0;
  
  for (const [roomId, room] of rooms.entries()) {
    if (now - room.createdAt > maxAge) {
      // Check if users still exist and notify them
      const user1 = users.get(room.user1Id);
      const user2 = users.get(room.user2Id);
      
      if (user1) user1.roomId = null;
      if (user2) user2.roomId = null;
      
      rooms.delete(roomId);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    console.log(`Cleaned up ${cleanedCount} old rooms`);
  }
}, 5 * 60 * 1000); // Run every 5 minutes

// Cleanup disconnected users from waiting queue
setInterval(() => {
  let cleanedCount = 0;
  for (let i = waitingQueue.length - 1; i >= 0; i--) {
    const userId = waitingQueue[i];
    const user = users.get(userId);
    
    if (!user || !user.socket || !user.socket.connected) {
      waitingQueue.splice(i, 1);
      if (user) users.delete(userId);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    console.log(`Cleaned up ${cleanedCount} disconnected users from queue`);
    broadcastUserCount();
  }
}, 2 * 60 * 1000); // Run every 2 minutes

// Periodic user count broadcast
setInterval(() => {
  broadcastUserCount();
}, 30 * 1000); // Every 30 seconds

// Error handling
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  broadcastUserCount();
});