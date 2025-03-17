"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

export default function Room({ params }) {
  const { roomId } = params;
  const router = useRouter();

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);

  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);

  useEffect(() => {
    const socket = new WebSocket("wss://webrtc-demo-tndz.onrender.com");
    socketRef.current = socket;

    socket.onopen = () => {
      console.log("Connected to WebSocket server");
      socket.send(JSON.stringify({ type: "join", room: roomId }));
    };

    socket.onmessage = (message) => handleMessage(JSON.parse(message.data));
    socket.onerror = (err) => console.error("Socket error:", err);

    return () => {
      socket.close();
    };
  }, [roomId]);

  useEffect(() => {
    if (!socketRef.current) return;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    peerConnectionRef.current = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current?.send(
          JSON.stringify({
            type: "candidate",
            candidate: event.candidate,
            room: roomId,
          })
        );
      }
    };

    pc.ontrack = (event) => {
      console.log("Received remote track:", event.streams[0]);
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    navigator.mediaDevices
      .getUserMedia({ video: true, audio: true })
      .then((stream) => {
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      })
      .catch((error) => console.error("Error accessing media devices:", error));

    return () => {
      pc.close();
    };
  }, [roomId]);

  const handleMessage = async (message) => {
    const pc = peerConnectionRef.current;
    if (!pc) return;

    console.log("Received message:", message);

    if (message.type === "offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(message.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socketRef.current?.send(JSON.stringify({ type: "answer", answer, room: roomId }));
    } else if (message.type === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription(message.answer));
    } else if (message.type === "candidate") {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(message.candidate));
      } catch (err) {
        console.error("Error adding ICE candidate:", err);
      }
    }
  };

  const startCall = async () => {
    const pc = peerConnectionRef.current;
    if (!pc) return;

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socketRef.current?.send(JSON.stringify({ type: "offer", offer, room: roomId }));
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-900 text-white">
      <h1 className="text-2xl font-bold mb-4">Room: {roomId}</h1>
      <div className="flex space-x-4">
        <video ref={localVideoRef} autoPlay playsInline className="w-1/2 border" />
        <video ref={remoteVideoRef} autoPlay playsInline className="w-1/2 border" />
      </div>
      <button onClick={startCall} className="px-4 py-2 mt-4 bg-green-600 rounded">
        Start Call (Caller Only)
      </button>
      <button onClick={() => router.push("/")} className="px-4 py-2 mt-4 bg-red-600 rounded">
        Leave
      </button>
    </div>
  );
}
