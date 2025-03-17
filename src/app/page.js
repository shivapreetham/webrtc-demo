// pages/index.js
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const [roomId, setRoomId] = useState("");
  const router = useRouter();

  const handleJoin = () => {
    if (roomId.trim()) {
      router.push(`/room/${roomId}`);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-900 text-white">
      <h1 className="text-4xl font-bold mb-8">WebRTC Video Chat</h1>
      <input
        type="text"
        placeholder="Enter Room ID"
        value={roomId}
        onChange={(e) => setRoomId(e.target.value)}
        className="p-2 rounded text-black mb-4"
      />
      <button
        onClick={handleJoin}
        className="px-6 py-3 bg-green-600 rounded hover:bg-green-700"
      >
        Join Room
      </button>
    </div>
  );
}
