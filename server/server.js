const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

// Store active users and rooms
const waitingUsers = new Map(); // userId -> { socket, audioEnabled, videoEnabled, joinTime, token }
const activeRooms = new Map(); // roomId -> { user1, user2, created }
const tokenToUser = new Map(); // token -> { userId, socketId, roomId? }
const userConnections = new Map(); // userId -> socketId
const userCount = { count: 0 };

// Generate unique IDs
const generateId = () => Math.random().toString(36).substr(2, 9);
const generateRoomId = () => Math.random().toString(36).substr(2, 12);
const generateToken = () => crypto.randomBytes(16).toString('hex');

// Determine initiator based on join time
const determineInitiator = (user1Id, user1Data, user2Id, user2Data) => {
  if (user1Data.joinTime < user2Data.joinTime) {
    return { initiator: user1Id, responder: user2Id };
  } else if (user2Data.joinTime < user1Data.joinTime) {
    return { initiator: user2Id, responder: user1Id };
  }
  
  // If join times are same, use alphabetical order
  return user1Id < user2Id 
    ? { initiator: user1Id, responder: user2Id }
    : { initiator: user2Id, responder: user1Id };
};

// Broadcast user count
const broadcastUserCount = () => {
  io.emit('user_count', { count: userCount.count });
};

// Find a suitable partner
const findPartner = (userId) => {
  for (const [waitingUserId, userData] of waitingUsers) {
    if (waitingUserId !== userId) {
      return { userId: waitingUserId, userData };
    }
  }
  return null;
};

// Clean up user from all data structures
const cleanupUser = (userId) => {
  console.log(`[SERVER] Cleaning up user ${userId}`);
  
  // Remove from waiting list
  waitingUsers.delete(userId);
  
  // Remove from active rooms and notify partner
  for (const [roomId, roomData] of activeRooms.entries()) {
    if (roomData.user1.id === userId || roomData.user2.id === userId) {
      const otherUser = roomData.user1.id === userId ? roomData.user2 : roomData.user1;
      
      console.log(`[SERVER] Notifying ${otherUser.id} about ${userId}'s disconnection`);
      
      // Notify the other user
      const otherSocket = io.sockets.sockets.get(otherUser.socketId);
      if (otherSocket) {
        otherSocket.emit('partner_disconnected');
      }
      
      // Remove room
      activeRooms.delete(roomId);
      
      // Update token mapping
      for (const [token, userData] of tokenToUser.entries()) {
        if (userData.userId === otherUser.id) {
          userData.roomId = null;
          break;
        }
      }
      
      console.log(`[SERVER] Room ${roomId} closed due to disconnection`);
      break;
    }
  }
  
  // Clean up user connections
  userConnections.delete(userId);
};

io.on('connection', (socket) => {
  const userId = generateId();
  const token = generateToken();
  socket.userId = userId;
  socket.token = token;

  // Track user connection
  userConnections.set(userId, socket.id);
  
  // Store token->user mapping
  tokenToUser.set(token, { userId, socketId: socket.id, roomId: null });

  userCount.count++;
  broadcastUserCount();
  
  console.log(`[SERVER] User ${userId} connected. Socket: ${socket.id}. Total: ${userCount.count}`);

  // Send welcome with token
  socket.emit('welcome', { userId, token });

  // Handle reconnection
  socket.on('reconnect_user', (data) => {
    const { token: clientToken } = data;
    const entry = tokenToUser.get(clientToken);
    
    if (entry && entry.userId) {
      // Update socket reference
      entry.socketId = socket.id;
      socket.userId = entry.userId;
      socket.token = clientToken;
      userConnections.set(entry.userId, socket.id);
      
      // Update waitingUsers if present
      if (waitingUsers.has(entry.userId)) {
        const userData = waitingUsers.get(entry.userId);
        userData.socket = socket;
        waitingUsers.set(entry.userId, userData);
      }
      
      // Update activeRooms socket references
      for (const [roomId, room] of activeRooms.entries()) {
        if (room.user1.id === entry.userId) {
          room.user1.socket = socket;
          room.user1.socketId = socket.id;
        }
        if (room.user2.id === entry.userId) {
          room.user2.socket = socket;
          room.user2.socketId = socket.id;
        }
      }
      
      socket.emit('reconnect_success', { 
        room: entry.roomId || null,
        userId: entry.userId 
      });
      console.log(`[SERVER] Reconnect successful for ${entry.userId}`);
    } else {
      socket.emit('reconnect_failed');
      console.log(`[SERVER] Reconnect failed for token ${clientToken}`);
    }
  });

  // Handle find partner
  socket.on('find_partner', (data) => {
    const { audioEnabled = true, videoEnabled = true } = data;
    console.log(`[SERVER] User ${userId} looking for partner`);
    
    // Check if already waiting or in room
    if (waitingUsers.has(userId)) {
      console.log(`[SERVER] User ${userId} already waiting`);
      return;
    }
    
    const existingRoom = Array.from(activeRooms.entries()).find(([_, roomData]) => 
      roomData.user1.id === userId || roomData.user2.id === userId
    );
    if (existingRoom) {
      console.log(`[SERVER] User ${userId} already in room`);
      return;
    }
    
    // Find partner
    const partner = findPartner(userId);
    
    if (partner) {
      const roomId = generateRoomId();
      const partnerData = partner.userData;
      
      console.log(`[SERVER] Pairing ${userId} with ${partner.userId}`);
      
      // Remove from waiting
      waitingUsers.delete(partner.userId);
      waitingUsers.delete(userId);
      
      // Determine roles
      const myJoinTime = Date.now();
      const partnerJoinTime = partnerData.joinTime || Date.now();
      const roles = determineInitiator(
        userId, { joinTime: myJoinTime }, 
        partner.userId, { joinTime: partnerJoinTime }
      );
      
      // Create room
      const roomData = {
        user1: { 
          id: roles.initiator, 
          socket: roles.initiator === userId ? socket : partnerData.socket,
          socketId: roles.initiator === userId ? socket.id : partnerData.socket.id,
          initiator: true 
        },
        user2: { 
          id: roles.responder, 
          socket: roles.responder === userId ? socket : partnerData.socket,
          socketId: roles.responder === userId ? socket.id : partnerData.socket.id,
          initiator: false 
        },
        created: Date.now()
      };
      
      activeRooms.set(roomId, roomData);

      // Update token mappings
      for (const [token, userData] of tokenToUser.entries()) {
        if (userData.userId === roles.initiator || userData.userId === roles.responder) {
          userData.roomId = roomId;
        }
      }
      
      // Notify both users
      roomData.user1.socket.emit('room_assigned', {
        room: roomId,
        initiator: true,
        role: 'initiator',
        partnerId: roles.responder
      });
      
      roomData.user2.socket.emit('room_assigned', {
        room: roomId,
        initiator: false,
        role: 'responder', 
        partnerId: roles.initiator
      });
      
      console.log(`[SERVER] Room ${roomId} created: ${roles.initiator} (init) & ${roles.responder} (resp)`);
    } else {
      // Add to waiting list
      waitingUsers.set(userId, {
        socket,
        audioEnabled,
        videoEnabled,
        joinTime: Date.now(),
        token
      });
      
      console.log(`[SERVER] User ${userId} added to waiting. Total: ${waitingUsers.size}`);
    }
  });

  // Handle room join
  socket.on('join_room', (data) => {
    const { room: roomToJoin, token: clientToken } = data;
    console.log(`[SERVER] ${userId} joining room ${roomToJoin}`);
    
    const room = activeRooms.get(roomToJoin);
    if (!room) {
      socket.emit('join_failed', { reason: 'no_room' });
      return;
    }

    // Update socket if token matches
    if (clientToken && tokenToUser.has(clientToken)) {
      const entry = tokenToUser.get(clientToken);
      if (entry.userId === userId) {
        entry.socketId = socket.id;
        userConnections.set(userId, socket.id);
        
        // Update room references
        if (room.user1.id === userId) {
          room.user1.socket = socket;
          room.user1.socketId = socket.id;
        } else if (room.user2.id === userId) {
          room.user2.socket = socket;
          room.user2.socketId = socket.id;
        }
      }
    }
    
    // Verify user belongs to room
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

  // Handle skip
  socket.on('skip', () => {
    const userRoom = Array.from(activeRooms.entries()).find(([_, roomData]) => 
      roomData.user1.id === userId || roomData.user2.id === userId
    );
    
    if (userRoom) {
      const [roomId, roomData] = userRoom;
      const otherUser = roomData.user1.id === userId ? roomData.user2 : roomData.user1;
      
      console.log(`[SERVER] ${userId} skipping in room ${roomId}`);
      
      // Notify partner
      const otherSocket = io.sockets.sockets.get(otherUser.socketId);
      if (otherSocket) {
        otherSocket.emit('partner_skipped');
      }
      
      // Close room
      activeRooms.delete(roomId);
      
      // Clear token mappings
      for (const [token, userData] of tokenToUser.entries()) {
        if (userData.userId === userId || userData.userId === otherUser.id) {
          userData.roomId = null;
        }
      }
    }
  });

  // WebRTC signaling
  socket.on('offer', (data) => {
    const { room: targetRoomId, offer } = data;
    const room = activeRooms.get(targetRoomId);
    
    if (!room) return;
    
    const isUser1 = room.user1.id === userId;
    const isUser2 = room.user2.id === userId;
    
    if (!isUser1 && !isUser2) return;
    
    const targetUser = isUser1 ? room.user2 : room.user1;
    const targetSocket = io.sockets.sockets.get(targetUser.socketId);
    
    if (targetSocket) {
      targetSocket.emit('offer', { offer, senderId: userId });
      console.log(`[SERVER] Forwarded offer from ${userId} to ${targetUser.id}`);
    }
  });

  socket.on('answer', (data) => {
    const { room: targetRoomId, answer } = data;
    const room = activeRooms.get(targetRoomId);
    
    if (!room) return;
    
    const isUser1 = room.user1.id === userId;
    const isUser2 = room.user2.id === userId;
    
    if (!isUser1 && !isUser2) return;
    
    const targetUser = isUser1 ? room.user2 : room.user1;
    const targetSocket = io.sockets.sockets.get(targetUser.socketId);
    
    if (targetSocket) {
      targetSocket.emit('answer', { answer, senderId: userId });
      console.log(`[SERVER] Forwarded answer from ${userId} to ${targetUser.id}`);
    }
  });

  socket.on('ice-candidate', (data) => {
    const { room: targetRoomId, candidate } = data;
    const room = activeRooms.get(targetRoomId);
    
    if (!room) return;
    
    const isUser1 = room.user1.id === userId;
    const isUser2 = room.user2.id === userId;
    
    if (!isUser1 && !isUser2) return;
    
    const targetUser = isUser1 ? room.user2 : room.user1;
    const targetSocket = io.sockets.sockets.get(targetUser.socketId);
    
    if (targetSocket) {
      targetSocket.emit('ice-candidate', { candidate, senderId: userId });
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`[SERVER] User ${userId} disconnected`);
    
    cleanupUser(userId);
    
    // Keep token for potential reconnection
    if (token && tokenToUser.has(token)) {
      const userData = tokenToUser.get(token);
      userData.socketId = null;
    }
    
    userCount.count = Math.max(0, userCount.count - 1);
    broadcastUserCount();
    console.log(`[SERVER] Cleanup complete. Total users: ${userCount.count}`);
  });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`[SERVER] Socket.IO server running on port ${PORT}`);
});

// Cleanup and status logging
setInterval(() => {
  const now = Date.now();
  let cleanedRooms = 0;
  
  // Clean up old rooms (10 minutes)
  for (const [roomId, roomData] of activeRooms.entries()) {
    if (now - roomData.created > 10 * 60 * 1000) {
      console.log(`[SERVER] Cleaning up old room: ${roomId}`);
      activeRooms.delete(roomId);
      cleanedRooms++;
    }
  }
  
  console.log(`[SERVER] Status - Active rooms: ${activeRooms.size}, Waiting: ${waitingUsers.size}, Users: ${userCount.count}, Cleaned: ${cleanedRooms}`);
  
  // Log active rooms
  if (activeRooms.size > 0) {
    console.log(`[SERVER] Active rooms:`);
    for (const [roomId, roomData] of activeRooms.entries()) {
      console.log(`  - ${roomId}: ${roomData.user1.id} (init) & ${roomData.user2.id} (resp)`);
    }
  }
  
  if (waitingUsers.size > 0) {
    console.log(`[SERVER] Waiting users: ${Array.from(waitingUsers.keys()).join(', ')}`);
  }
}, 30000);