// server.js
require("dotenv").config();
const express = require("express");
const { WebSocketServer } = require("ws");
const cors = require("cors");

const PORT = process.env.PORT || 10000;
const app = express();

app.use(cors());
app.use(express.json());

// Start Express server
const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Create a WebSocket server on the same HTTP server
const wss = new WebSocketServer({ server });
const rooms = {};

wss.on("connection", (ws) => {
  ws.on("message", (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (err) {
      console.error("Invalid JSON:", err);
      return;
    }
    const { type, room } = data;
    switch (type) {
      case "join":
        if (!rooms[room]) rooms[room] = [];
        rooms[room].push(ws);
        console.log(`User joined room: ${room}`);
        break;
      case "offer":
      case "answer":
      case "candidate":
        if (rooms[room]) {
          rooms[room].forEach((client) => {
            if (client !== ws && client.readyState === client.OPEN) {
              client.send(JSON.stringify(data));
            }
          });
        }
        break;
    }
  });

  ws.on("close", () => {
    Object.keys(rooms).forEach((room) => {
      rooms[room] = rooms[room].filter((client) => client !== ws);
      if (rooms[room].length === 0) delete rooms[room];
    });
  });
});
