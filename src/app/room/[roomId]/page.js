// pages/room/[roomId]/page.js
"use client";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

export default function Room({ params }) {
  const { roomId } = params;
  const router = useRouter();
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const socketRef = useRef(null);
  const pcRef = useRef(null);

  // Initialize WebSocket connection
  useEffect(() => {
    // Replace the URL below with your deployed signaling server URL if needed
    const socket = new WebSocket("wss://webrtc-demo-tndz.onrender.com");
    socketRef.current = socket;

    socket.onopen = () => {
      console.log("Connected to WebSocket server");
      socket.send(JSON.stringify({ type: "join", room: roomId }));
    };

    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      console.log("Received message:", data);
      handleSocketMessage(data);
    };

    socket.onerror = (err) => console.error("Socket error:", err);

    return () => {
      socket.close();
    };
  }, [roomId]);

  // Initialize RTCPeerConnection and local media
  useEffect(() => {
    if (!socketRef.current) return;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    pcRef.current = pc;

    // ICE candidate event
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current.send(
          JSON.stringify({
            type: "candidate",
            candidate: event.candidate,
            room: roomId,
          })
        );
      }
    };

    // Remote track event
    pc.ontrack = (event) => {
      console.log("Received remote track:", event.streams[0]);
      if (remoteVideoRef.current && !remoteVideoRef.current.srcObject) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    // Get local media stream
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
  }, [roomId]);

  // Handle incoming socket messages
  const handleSocketMessage = async (data) => {
    const pc = pcRef.current;
    if (!pc) return;
    if (data.type === "offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socketRef.current.send(
        JSON.stringify({ type: "answer", answer, room: roomId })
      );
    } else if (data.type === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    } else if (data.type === "candidate") {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        console.error("Error adding ICE candidate:", err);
      }
    }
  };

  // Caller initiates the call by creating an offer
  const startCall = async () => {
    const pc = pcRef.current;
    if (!pc) return;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socketRef.current.send(
      JSON.stringify({ type: "offer", offer, room: roomId })
    );
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-900 text-white p-4">
      <h1 className="text-3xl font-bold mb-4">Room: {roomId}</h1>
      <div className="flex flex-col md:flex-row space-y-4 md:space-y-0 md:space-x-4 mb-4 w-full max-w-4xl">
        <video
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          className="w-full md:w-1/2 border rounded"
        />
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          className="w-full md:w-1/2 border rounded"
        />
      </div>
      <div className="flex space-x-4">
        <button
          onClick={startCall}
          className="px-4 py-2 bg-green-600 rounded hover:bg-green-700"
        >
          Start Call (Caller Only)
        </button>
        <button
          onClick={() => router.push("/")}
          className="px-4 py-2 bg-red-600 rounded hover:bg-red-700"
        >
          Leave
        </button>
      </div>
    </div>
  );
}
