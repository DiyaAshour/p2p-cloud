import { WebSocketServer } from "ws";

const PORT = 8788;
const peers = new Map();

const server = new WebSocketServer({ host: "0.0.0.0", port: PORT });

server.on("connection", (socket) => {
  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "peer:register") {
      peers.set(msg.peerId, { ...msg, socket });

      socket.send(JSON.stringify({
        type: "bootstrap:peers",
        peers: Array.from(peers.values()).map(p => ({ peerId: p.peerId, url: p.url }))
      }));

      for (const peer of peers.values()) {
        if (peer.socket !== socket) {
          peer.socket.send(JSON.stringify({
            type: "bootstrap:new-peer",
            peer: { peerId: msg.peerId, url: msg.url }
          }));
        }
      }
    }
  });

  socket.on("close", () => {
    for (const [id, peer] of peers.entries()) {
      if (peer.socket === socket) {
        peers.delete(id);
      }
    }
  });
});

console.log(`Global Bootstrap running on ws://0.0.0.0:${PORT}`);
