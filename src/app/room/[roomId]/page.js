"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

export default function Room({ params }) {
  const { roomId } = params;
  const router = useRouter();

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);

  const [socket, setSocket] = useState(null);
  const [peerConnection, setPeerConnection] = useState(null);

  // Initialize WebSocket connection
  useEffect(() => {
    const ws = new WebSocket("wss://webrtc-demo-tndz.onrender.com");
    setSocket(ws);

    ws.onopen = () => {
      console.log("Connected to WebSocket server");
      ws.send(JSON.stringify({ type: "join", room: roomId }));
    };

    ws.onmessage = (message) => handleMessage(JSON.parse(message.data));
    ws.onerror = (err) => console.error("Socket error:", err);

    return () => {
      ws.close();
    };
  }, [roomId]);

  // Initialize PeerConnection and local media once the WebSocket is ready
  useEffect(() => {
    if (!socket) return;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    setPeerConnection(pc);

    // Send ICE candidates to signaling server
    pc.onicecandidate = (event) => {
      if (event.candidate && socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "candidate",
            candidate: event.candidate,
            room: roomId,
          })
        );
      }
    };

    // When remote stream arrives, show it in the remote video element
    pc.ontrack = (event) => {
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    // Get local media and add tracks to peer connection
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: true })
      .then((stream) => {
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      })
      .catch((error) => {
        console.error("Error accessing media devices:", error);
      });

    return () => {
      pc.close();
    };
  }, [socket, roomId]);

  // Handle incoming signaling messages
  const handleMessage = async (message) => {
    if (!peerConnection) {
      console.log("PeerConnection not ready. Message:", message);
      return;
    }
    console.log("Received message:", message);
    if (message.type === "offer") {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(message.offer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.send(JSON.stringify({ type: "answer", answer, room: roomId }));
    } else if (message.type === "answer") {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));
    } else if (message.type === "candidate") {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
      } catch (err) {
        console.error("Error adding ICE candidate:", err);
      }
    }
  };

  // Start call: Caller triggers offer on the existing connection
  const startCall = async () => {
    if (!peerConnection) {
      console.error("PeerConnection not initialized yet.");
      return;
    }
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.send(JSON.stringify({ type: "offer", offer, room: roomId }));
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-900 text-white">
      <h1 className="text-2xl font-bold mb-4">Room: {roomId}</h1>
      <div className="flex space-x-4">
        <video ref={localVideoRef} autoPlay playsInline className="w-1/2 border" />
        <video ref={remoteVideoRef} autoPlay playsInline className="w-1/2 border" />
      </div>
      {/* Only the caller should click this button */}
      <button onClick={startCall} className="px-4 py-2 mt-4 bg-green-600 rounded">
        Start Call (Caller Only)
      </button>
      <button onClick={() => router.push("/")} className="px-4 py-2 mt-4 bg-red-600 rounded">
        Leave
      </button>
    </div>
  );
}
