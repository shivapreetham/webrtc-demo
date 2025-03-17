"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import "../../styles/room.css"; // Make sure the path is correct

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

  // Initialize PeerConnection and local media stream
  useEffect(() => {
    if (!socketRef.current) return;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    pcRef.current = pc;

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

    pc.oniceconnectionstatechange = () => {
      console.log("ICE Connection State:", pc.iceConnectionState);
    };

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

  const resumeRemoteVideo = () => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current
        .play()
        .catch((err) => console.error("Manual play error:", err));
    }
  };

  return (
    <div className="container">
      <header className="header">
        <h1>Room: {roomId}</h1>
      </header>
      <div className="video-container">
        <div className="video-card">
          <h2>Your Video</h2>
          <video ref={localVideoRef} autoPlay playsInline muted />
        </div>
        <div className="video-card">
          <h2>Remote Video</h2>
          <video ref={remoteVideoRef} autoPlay playsInline />
        </div>
      </div>
      <div className="button-group">
        <button onClick={startCall} className="start">
          Start Call (Caller Only)
        </button>
        <button onClick={resumeRemoteVideo} className="resume">
          Resume Remote Video
        </button>
        <button onClick={() => router.push("/")} className="leave">
          Leave
        </button>
      </div>
      <footer className="footer">
        Note: Testing on the same device may trigger camera/mic conflicts.
      </footer>
    </div>
  );
}
