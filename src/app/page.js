'use client';

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

export default function Room({ params }) {
  const { roomId } = params;
  const [socket, setSocket] = useState(null);
  const [peerConnection, setPeerConnection] = useState(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  
  useEffect(() => {
    const ws = new WebSocket("wss://your-signaling-server.com");
    setSocket(ws);
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", roomId }));
    ws.onmessage = handleMessage;
    return () => ws.close();
  }, []);
  
  const handleMessage = async (message) => {
    const data = JSON.parse(message.data);
    if (data.type === "offer") {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.send(JSON.stringify({ type: "answer", answer }));
    }
    if (data.type === "answer") {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
    }
    if (data.type === "candidate") {
      await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  };
  
  useEffect(() => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    setPeerConnection(pc);
    pc.onicecandidate = (event) => {
      if (event.candidate) socket.send(JSON.stringify({ type: "candidate", candidate: event.candidate }));
    };
    pc.ontrack = (event) => (remoteVideoRef.current.srcObject = event.streams[0]);
    navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then((stream) => {
      localVideoRef.current.srcObject = stream;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    });
    return () => pc.close();
  }, []);
  
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-900 text-white">
      <h1 className="text-2xl font-bold">Room: {roomId}</h1>
      <video ref={localVideoRef} autoPlay playsInline className="w-1/3 border" />
      <video ref={remoteVideoRef} autoPlay playsInline className="w-1/3 border mt-4" />
    </div>
  );
}
