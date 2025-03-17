const WebSocket = require("ws");

// Bind to the PORT environment variable; default to 10000 if not provided
const PORT = process.env.PORT || 10000;
const wss = new WebSocket.Server({ port: PORT });

console.log(`WebSocket server running on port ${PORT}`);

let rooms = {};

wss.on("connection", (ws) => {
  ws.on("message", (message) => {
    const data = JSON.parse(message);
    const { type, room } = data;

    switch (type) {
      case "join":
        if (!rooms[room]) {
          rooms[room] = [];
        }
        rooms[room].push(ws);
        console.log(`User joined room: ${room}`);
        break;

      case "offer":
      case "answer":
      case "candidate":
        if (rooms[room]) {
          rooms[room].forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
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
      if (rooms[room].length === 0) {
        delete rooms[room];
      }
    });
  });
});
