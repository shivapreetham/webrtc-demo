"use client";

import { useEffect, useRef } from "react";
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

  // Initialize RTCPeerConnection and local media stream
  useEffect(() => {
    if (!socketRef.current) return;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    pcRef.current = pc;

    // ICE candidate handler: send candidates to the signaling server
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

    // Log ICE connection state changes
    pc.oniceconnectionstatechange = () => {
      console.log("ICE Connection State:", pc.iceConnectionState);
    };

    // Remote track handler: assign received stream to remote video element
    pc.ontrack = (event) => {
      console.log("Received remote track:", event.streams[0]);
      if (remoteVideoRef.current && !remoteVideoRef.current.srcObject) {
        remoteVideoRef.current.srcObject = event.streams[0];
        remoteVideoRef.current
          .play()
          .then(() => console.log("Remote video playback started"))
          .catch((err) =>
            console.error("Error playing remote video:", err)
          );
      }
    };

    // Get local media and add tracks to the connection
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: true })
      .then((stream) => {
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
          localVideoRef.current
            .play()
            .then(() => console.log("Local video playback started"))
            .catch((err) =>
              console.error("Error playing local video:", err)
            );
        }
        stream.getTracks().forEach((track) => {
          console.log(`Adding local ${track.kind} track`);
          pc.addTrack(track, stream);
        });
      })
      .catch((error) => console.error("Error accessing media devices:", error));

    return () => {
      pc.close();
    };
  }, [roomId]);

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

  // Caller initiates the call by creating and sending an offer
  const startCall = async () => {
    const pc = pcRef.current;
    if (!pc) {
      console.error("PeerConnection not initialized yet.");
      return;
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socketRef.current.send(
      JSON.stringify({ type: "offer", offer, room: roomId })
    );
  };

  // Optional: Resume remote video playback manually (for mobile gestures)
  const resumeRemoteVideo = () => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current
        .play()
        .catch((err) => console.error("Manual play error:", err));
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-r from-blue-600 to-purple-600 text-white flex flex-col items-center p-8">
      <header className="mb-8">
        <h1 className="text-4xl font-extrabold">Room: {roomId}</h1>
      </header>
      <div className="w-full max-w-5xl flex flex-col md:flex-row gap-8 mb-8">
        <div className="flex-1 bg-white/10 p-4 rounded shadow-lg flex flex-col items-center">
          <h2 className="text-xl font-semibold mb-2">Your Video</h2>
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-auto rounded"
          />
        </div>
        <div className="flex-1 bg-white/10 p-4 rounded shadow-lg flex flex-col items-center">
          <h2 className="text-xl font-semibold mb-2">Remote Video</h2>
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className="w-full h-auto rounded"
          />
        </div>
      </div>
      <div className="flex flex-col md:flex-row gap-4">
        <button
          onClick={startCall}
          className="px-6 py-3 bg-green-600 hover:bg-green-700 rounded font-semibold"
        >
          Start Call (Caller Only)
        </button>
        <button
          onClick={resumeRemoteVideo}
          className="px-6 py-3 bg-blue-600 hover:bg-blue-700 rounded font-semibold"
        >
          Resume Remote Video
        </button>
        <button
          onClick={() => router.push("/")}
          className="px-6 py-3 bg-red-600 hover:bg-red-700 rounded font-semibold"
        >
          Leave
        </button>
      </div>
      <footer className="mt-8 text-sm opacity-75">
        Note: Using the same device for both peers may trigger camera/mic conflicts.
      </footer>
    </div>
  );
}
