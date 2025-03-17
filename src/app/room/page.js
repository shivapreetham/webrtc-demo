import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export default function Room({ params }) {
  const { roomId } = params;
  const router = useRouter();
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const [ws, setWs] = useState(null);
  const [peerConnection, setPeerConnection] = useState(null);

  useEffect(() => {
    const socket = new WebSocket("ws://localhost:3001");
    setWs(socket);

    socket.onopen = () => socket.send(JSON.stringify({ type: "join", roomId }));
    socket.onmessage = async (message) => handleMessage(JSON.parse(message.data));

    return () => socket.close();
  }, [roomId]);

  const handleMessage = async (message) => {
    if (message.type === "offer") {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(message.offer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: "answer", answer, roomId }));
    }
    if (message.type === "answer") {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));
    }
    if (message.type === "candidate") {
      await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
    }
  };

  const startCall = async () => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    setPeerConnection(pc);

    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideoRef.current.srcObject = stream;
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    pc.ontrack = (event) => (remoteVideoRef.current.srcObject = event.streams[0]);
    pc.onicecandidate = (event) => event.candidate && ws.send(JSON.stringify({ type: "candidate", candidate: event.candidate, roomId }));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: "offer", offer, roomId }));
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-900 text-white">
      <h1 className="text-2xl font-bold mb-4">Room: {roomId}</h1>
      <div className="flex space-x-4">
        <video ref={localVideoRef} autoPlay playsInline className="w-1/2 border" />
        <video ref={remoteVideoRef} autoPlay playsInline className="w-1/2 border" />
      </div>
      <button onClick={startCall} className="px-4 py-2 mt-4 bg-green-600 rounded">Start Call</button>
      <button onClick={() => router.push("/")} className="px-4 py-2 mt-4 bg-red-600 rounded">Leave</button>
    </div>
  );
}
