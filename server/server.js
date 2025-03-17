// WebSocket Signaling Server (server.js)

const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

let clients = {};

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        let data = JSON.parse(message);
        
        switch (data.type) {
            case 'join':
                clients[data.room] = clients[data.room] || [];
                clients[data.room].push(ws);
                break;
            case 'offer':
            case 'answer':
            case 'candidate':
                clients[data.room]?.forEach(client => {
                    if (client !== ws) {
                        client.send(JSON.stringify(data));
                    }
                });
                break;
        }
    });

    ws.on('close', () => {
        for (let room in clients) {
            clients[room] = clients[room].filter(client => client !== ws);
        }
    });
});
