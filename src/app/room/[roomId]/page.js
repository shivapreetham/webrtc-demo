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

    return () => {
      ws.close();
    };
  }, [roomId]);

  // Initialize PeerConnection and local media on mount
  useEffect(() => {
    const initConnection = async () => {
      // Create the RTCPeerConnection
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      setPeerConnection(pc);

      // Set up ICE candidate handler
      pc.onicecandidate = (event) => {
        if (event.candidate && socket) {
          socket.send(
            JSON.stringify({ type: "candidate", candidate: event.candidate, room: roomId })
          );
        }
      };

      // Handle remote stream addition
      pc.ontrack = (event) => {
        remoteVideoRef.current.srcObject = event.streams[0];
      };

      try {
        // Get local media stream
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideoRef.current.srcObject = stream;
        // Add tracks to the connection
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      } catch (error) {
        console.error("Error accessing media devices.", error);
      }
    };

    // Only initialize once the WebSocket is ready
    if (socket) {
      initConnection();
    }
  }, [socket, roomId]);

  // Handle incoming WebSocket messages
  const handleMessage = async (message) => {
    if (!peerConnection) return;

    if (message.type === "offer") {
      console.log("Received offer, setting remote description");
      await peerConnection.setRemoteDescription(new RTCSessionDescription(message.offer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.send(JSON.stringify({ type: "answer", answer, room: roomId }));
    } else if (message.type === "answer") {
      console.log("Received answer, setting remote description");
      await peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));
    } else if (message.type === "candidate") {
      console.log("Received ICE candidate, adding to peer connection");
      await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
    }
  };

  // Create offer (should be triggered by the caller only)
  const startCall = async () => {
    if (!peerConnection) return;
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
      {/* Only one user should click this button (the caller) */}
      <button onClick={startCall} className="px-4 py-2 mt-4 bg-green-600 rounded">
        Start Call (Caller Only)
      </button>
      <button onClick={() => router.push("/")} className="px-4 py-2 mt-4 bg-red-600 rounded">
        Leave
      </button>
    </div>
  );
}
