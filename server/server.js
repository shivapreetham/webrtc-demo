require("dotenv").config();
const express = require("express");
const { WebSocketServer } = require("ws");
const cors = require("cors");

const PORT = process.env.PORT || 10000;
const app = express();

app.use(cors());
app.use(express.json());

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

const wss = new WebSocketServer({ server });
const rooms = {};

wss.on("connection", (ws) => {
  ws.on("message", (message) => {
    const data = JSON.parse(message);
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
            if (client !== ws && client.readyState === 1) {
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
