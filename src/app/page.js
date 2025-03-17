"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import "../styles/lobby.css"; // Ensure this path is correct

export default function Home() {
  const [roomId, setRoomId] = useState("");
  const router = useRouter();

  const handleJoin = () => {
    if (roomId.trim()) {
      router.push(`/room/${roomId}`);
    }
  };

  return (
    <div className="container">
      <h1>WebRTC Video Chat</h1>
      <input
        type="text"
        placeholder="Enter Room ID"
        value={roomId}
        onChange={(e) => setRoomId(e.target.value)}
        className="input-field"
      />
      <button onClick={handleJoin} className="join-button">
        Join Room
      </button>
    </div>
  );
}
