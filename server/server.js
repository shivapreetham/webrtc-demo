const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');

const server = http.createServer();
const wss = new WebSocket.Server({ server });

// Store active users and rooms
const waitingUsers = new Map(); // userId -> { socket, audioEnabled, videoEnabled, joinTime, token }
const activeRooms = new Map(); // roomId -> { user1, user2, created }
const tokenToUser = new Map(); // token -> { userId, socket, roomId? }
const userConnections = new Map(); // userId -> socket (track current socket)
const userCount = { count: 0 };

// Generate unique IDs
const generateId = () => Math.random().toString(36).substr(2, 9);
const generateRoomId = () => Math.random().toString(36).substr(2, 12);
const generateToken = () => crypto.randomBytes(16).toString('hex');

// Determine initiator based on deterministic criteria
const determineInitiator = (user1Id, user1Data, user2Id, user2Data) => {
  // Use join time (first to join becomes initiator)
  if (user1Data.joinTime < user2Data.joinTime) {
    return { initiator: user1Id, responder: user2Id };
  } else if (user2Data.joinTime < user1Data.joinTime) {
    return { initiator: user2Id, responder: user1Id };
  }
  
  // If join times are the same, use alphabetical order of user IDs
  if (user1Id < user2Id) {
    return { initiator: user1Id, responder: user2Id };
  } else {
    return { initiator: user2Id, responder: user1Id };
  }
};

// Broadcast user count to all connected clients
const broadcastUserCount = () => {
  const message = JSON.stringify({
    type: 'user_count',
    count: userCount.count
  });
  
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch (err) {
        console.warn('[SERVER] Error broadcasting user count:', err);
      }
    }
  });
};

// Find a suitable partner for a user
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
      
      console.log(`[SERVER] Notifying ${otherUser.id} about ${userId}'s disconnection from room ${roomId}`);
      
      // Notify the other user
      try {
        if (otherUser.socket && otherUser.socket.readyState === WebSocket.OPEN) {
          otherUser.socket.send(JSON.stringify({
            type: 'partner_disconnected'
          }));
        }
      } catch (err) {
        console.warn('[SERVER] Error sending disconnect notification:', err);
      }
      
      // Remove room
      activeRooms.delete(roomId);
      
      // Update token mapping for the other user
      for (const [token, userData] of tokenToUser.entries()) {
        if (userData.userId === otherUser.id) {
          userData.roomId = null;
          break;
        }
      }
      
      console.log(`[SERVER] Room ${roomId} closed due to user ${userId} disconnection`);
      break;
    }
  }
  
  // Clean up user connections
  userConnections.delete(userId);
};

// Send message safely to socket
const sendSafe = (socket, data) => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(data));
      return true;
    } catch (err) {
      console.warn('[SERVER] Error sending message:', err);
      return false;
    }
  }
  return false;
};

wss.on('connection', (ws) => {
  const userId = generateId();
  const token = generateToken();
  ws.userId = userId;
  ws.token = token;

  // Track user connection
  userConnections.set(userId, ws);
  
  // Store token->user mapping
  tokenToUser.set(token, { userId, socket: ws, roomId: null });

  userCount.count++;
  broadcastUserCount();
  
  console.log(`[SERVER] User ${userId} connected. Token: ${token}. Total users: ${userCount.count}`);

  // Send welcome with token
  sendSafe(ws, { type: 'welcome', userId, token });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      const curUserId = ws.userId;
      console.log(`[SERVER] Received message from ${curUserId}:`, data.type, data.room || '');
      
      switch (data.type) {
        case 'reconnect': {
          const { token: clientToken } = data;
          const entry = tokenToUser.get(clientToken);
          if (entry && entry.userId) {
            // Update socket reference
            entry.socket = ws;
            ws.userId = entry.userId;
            ws.token = clientToken;
            userConnections.set(entry.userId, ws);
            
            // Update waitingUsers if present
            if (waitingUsers.has(entry.userId)) {
              const userData = waitingUsers.get(entry.userId);
              userData.socket = ws;
              waitingUsers.set(entry.userId, userData);
            }
            
            // Update activeRooms user socket references
            for (const [roomId, room] of activeRooms.entries()) {
              if (room.user1.id === entry.userId) {
                room.user1.socket = ws;
              }
              if (room.user2.id === entry.userId) {
                room.user2.socket = ws;
              }
            }
            
            sendSafe(ws, { 
              type: 'reconnect_ok', 
              room: entry.roomId || null,
              userId: entry.userId 
            });
            console.log(`[SERVER] Reconnect successful for token ${clientToken} -> user ${entry.userId}`);
          } else {
            sendSafe(ws, { type: 'reconnect_failed' });
            console.log(`[SERVER] Reconnect failed for token ${clientToken}`);
          }
          break;
        }

        case 'find_partner': {
          const { audioEnabled = true, videoEnabled = true } = data;
          console.log(`[SERVER] User ${curUserId} looking for partner (audio: ${audioEnabled}, video: ${videoEnabled})`);
          
          // Check if user is already in waiting list or active room
          if (waitingUsers.has(curUserId)) {
            console.log(`[SERVER] User ${curUserId} already in waiting list`);
            return;
          }
          
          // Check if user is already in an active room
          const existingRoom = Array.from(activeRooms.entries()).find(([_, roomData]) => 
            roomData.user1.id === curUserId || roomData.user2.id === curUserId
          );
          if (existingRoom) {
            console.log(`[SERVER] User ${curUserId} already in active room ${existingRoom[0]}`);
            return;
          }
          
          // Find a partner
          const partner = findPartner(curUserId);
          
          if (partner) {
            // Create a room with both users
            const roomId = generateRoomId();
            const partnerData = partner.userData;
            
            console.log(`[SERVER] Found partner for ${curUserId}: ${partner.userId}`);
            
            // Remove both users from waiting list
            waitingUsers.delete(partner.userId);
            waitingUsers.delete(curUserId);
            
            // Determine initiator and responder
            const myJoinTime = Date.now();
            const partnerJoinTime = partnerData.joinTime || Date.now();
            const roles = determineInitiator(
              curUserId, { joinTime: myJoinTime }, 
              partner.userId, { joinTime: partnerJoinTime }
            );
            
            // Create room with proper roles
            const roomData = {
              user1: { 
                id: roles.initiator, 
                socket: roles.initiator === curUserId ? ws : partnerData.socket, 
                initiator: true 
              },
              user2: { 
                id: roles.responder, 
                socket: roles.responder === curUserId ? ws : partnerData.socket, 
                initiator: false 
              },
              created: Date.now()
            };
            
            activeRooms.set(roomId, roomData);

            // Update token mapping with roomId for both users
            for (const [token, userData] of tokenToUser.entries()) {
              if (userData.userId === roles.initiator || userData.userId === roles.responder) {
                userData.roomId = roomId;
              }
            }
            
            // Notify both users with their roles
            const initiatorData = {
              type: 'room_assigned',
              room: roomId,
              initiator: true,
              role: 'initiator',
              partnerId: roles.responder
            };
            
            const responderData = {
              type: 'room_assigned',
              room: roomId,
              initiator: false,
              role: 'responder',
              partnerId: roles.initiator
            };
            
            console.log(`[SERVER] Sending room_assigned to initiator ${roles.initiator}`);
            sendSafe(roomData.user1.socket, initiatorData);
            
            console.log(`[SERVER] Sending room_assigned to responder ${roles.responder}`);
            sendSafe(roomData.user2.socket, responderData);
            
            console.log(`[SERVER] Room ${roomId} created with ${roles.initiator} (initiator) and ${roles.responder} (responder)`);
          } else {
            // Add user to waiting list with join time
            waitingUsers.set(curUserId, {
              socket: ws,
              audioEnabled,
              videoEnabled,
              joinTime: Date.now(),
              token: ws.token
            });
            
            console.log(`[SERVER] User ${curUserId} added to waiting list. Total waiting: ${waitingUsers.size}`);
          }
          break;
        }
          
        case 'join': {
          const { room: roomToJoin, token: clientToken } = data;
          console.log(`[SERVER] User ${curUserId} trying to join room ${roomToJoin} (token: ${clientToken || 'none'})`);
          const room = activeRooms.get(roomToJoin);
          
          if (room) {
            // Update socket references if token matches
            if (clientToken && tokenToUser.has(clientToken)) {
              const entry = tokenToUser.get(clientToken);
              if (entry.userId === curUserId) {
                entry.socket = ws;
                userConnections.set(curUserId, ws);
                
                // Update room socket references
                if (room.user1.id === curUserId) {
                  room.user1.socket = ws;
                } else if (room.user2.id === curUserId) {
                  room.user2.socket = ws;
                }
              }
            }
            
            // Verify user belongs to this room
            const isUser1 = room.user1.id === curUserId;
            const isUser2 = room.user2.id === curUserId;
            
            if (isUser1 || isUser2) {
              const userData = isUser1 ? room.user1 : room.user2;
              const partnerData = isUser1 ? room.user2 : room.user1;
              
              const joinResponse = {
                type: 'room_joined',
                room: roomToJoin,
                initiator: userData.initiator,
                role: userData.initiator ? 'initiator' : 'responder',
                partnerId: partnerData.id
              };
              
              sendSafe(ws, joinResponse);
              console.log(`[SERVER] User ${curUserId} joined room ${roomToJoin} as ${userData.initiator ? 'initiator' : 'responder'}`);
            } else {
              sendSafe(ws, { type: 'join_failed', reason: 'not_in_room' });
              console.log(`[SERVER] User ${curUserId} not authorized for room ${roomToJoin}`);
            }
          } else {
            sendSafe(ws, { type: 'join_failed', reason: 'no_room' });
            console.log(`[SERVER] User ${curUserId} tried to join non-existent room ${roomToJoin}`);
          }
          break;
        }
          
        case 'skip': {
          // Handle skip request
          const userRoom = Array.from(activeRooms.entries()).find(([_, roomData]) => 
            roomData.user1.id === curUserId || roomData.user2.id === curUserId
          );
          
          if (userRoom) {
            const [roomId, roomData] = userRoom;
            const otherUser = roomData.user1.id === curUserId ? roomData.user2 : roomData.user1;
            
            console.log(`[SERVER] User ${curUserId} skipping in room ${roomId}`);
            
            // Notify the other user about the skip
            sendSafe(otherUser.socket, { type: 'partner_skipped' });
            
            // Close the room
            activeRooms.delete(roomId);
            
            // Update token mappings to clear roomId
            for (const [token, userData] of tokenToUser.entries()) {
              if (userData.userId === curUserId || userData.userId === otherUser.id) {
                userData.roomId = null;
              }
            }
            
            console.log(`[SERVER] Room ${roomId} closed due to skip.`);
          } else {
            console.log(`[SERVER] User ${curUserId} tried to skip but not in any room`);
          }
          break;
        }
          
        case 'offer':
        case 'answer':
        case 'candidate': {
          const { room: targetRoomId, token: clientToken } = data;
          const targetRoom = activeRooms.get(targetRoomId);
          const senderId = curUserId;
          
          if (!targetRoom) {
            console.warn(`[SERVER] No room ${targetRoomId} for ${data.type} from ${senderId}`);
            break;
          }
          
          // Verify sender is in the room
          const isUser1 = targetRoom.user1.id === senderId;
          const isUser2 = targetRoom.user2.id === senderId;
          
          if (!isUser1 && !isUser2) {
            console.warn(`[SERVER] User ${senderId} not in room ${targetRoomId} for ${data.type}`);
            break;
          }
          
          const targetUser = isUser1 ? targetRoom.user2 : targetRoom.user1;
          
          // Forward the message to the target user
          const forwardedData = {
            ...data,
            senderId,
            room: targetRoomId
          };
          
          if (sendSafe(targetUser.socket, forwardedData)) {
            console.log(`[SERVER] Forwarded ${data.type} from ${senderId} to ${targetUser.id} in room ${targetRoomId}`);
          } else {
            console.warn(`[SERVER] Failed to forward ${data.type} to ${targetUser.id} in room ${targetRoomId}`);
          }
          break;
        }
          
        default:
          console.log(`[SERVER] Unknown message type from ${curUserId}:`, data.type);
      }
    } catch (error) {
      console.error(`[SERVER] Error processing message from ${ws.userId}:`, error);
    }
  });

  ws.on('close', () => {
    const curUserId = ws.userId;
    console.log(`[SERVER] User ${curUserId} disconnected`);
    
    // Clean up user
    cleanupUser(curUserId);
    
    // Keep token mapping for potential reconnection, just mark socket as null
    if (ws.token && tokenToUser.has(ws.token)) {
      const userData = tokenToUser.get(ws.token);
      userData.socket = null;
    }
    
    userCount.count = Math.max(0, userCount.count - 1);
    broadcastUserCount();
    console.log(`[SERVER] User ${curUserId} cleanup complete. Total users: ${userCount.count}`);
  });

  ws.on('error', (error) => {
    console.error(`[SERVER] WebSocket error for user ${ws.userId}:`, error);
  });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`[SERVER] Omegle WebSocket server running on port ${PORT}`);
  console.log(`[SERVER] WebSocket URL: ws://localhost:${PORT}`);
});

// Cleanup inactive rooms and log status periodically
setInterval(() => {
  const now = Date.now();
  let cleanedRooms = 0;
  
  // Clean up very old rooms (10 minutes)
  for (const [roomId, roomData] of activeRooms.entries()) {
    if (now - roomData.created > 10 * 60 * 1000) {
      console.log(`[SERVER] Cleaning up old room: ${roomId}`);
      activeRooms.delete(roomId);
      cleanedRooms++;
    }
  }
  
  console.log(`[SERVER] Status - Active rooms: ${activeRooms.size}, Waiting users: ${waitingUsers.size}, Total users: ${userCount.count}, Cleaned: ${cleanedRooms}`);
  
  // Log active rooms for debugging
  if (activeRooms.size > 0) {
    console.log(`[SERVER] Active rooms:`);
    for (const [roomId, roomData] of activeRooms.entries()) {
      const user1Role = roomData.user1.initiator ? 'initiator' : 'responder';
      const user2Role = roomData.user2.initiator ? 'initiator' : 'responder';
      console.log(`  - ${roomId}: ${roomData.user1.id} (${user1Role}) & ${roomData.user2.id} (${user2Role})`);
    }
  }
  
  // Log waiting users
  if (waitingUsers.size > 0) {
    console.log(`[SERVER] Waiting users: ${Array.from(waitingUsers.keys()).join(', ')}`);
  }
  
  // Cleanup stale connections
  for (const [userId, socket] of userConnections.entries()) {
    if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
      console.log(`[SERVER] Cleaning up stale connection for user ${userId}`);
      cleanupUser(userId);
    }
  }
}, 30000); // Log every 30 seconds