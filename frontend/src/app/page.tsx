'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

/** Public landing page where general clients join a room by Room Code and facilitators open the console. */
export default function HomePage() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  /** Validates the entered room code and navigates to the mobile participant room. */
  function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    const cleaned = code.trim().toUpperCase();
    if (cleaned.length < 4 || cleaned.length > 12) {
      setError('Please enter a valid 4 to 12 character room code.');
      return;
    }
    router.push(`/join/${encodeURIComponent(cleaned)}`);
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-4 max-w-full overflow-x-hidden">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-6">
        <div>
          <span className="inline-block rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
            Live WorkShop
          </span>
          <h1 className="mt-2 text-2xl font-bold text-slate-900">
            Live WorkShop
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Enter a Room Code to join a live workshop room immediately without an account, or sign in as facilitator to create and manage sessions.
          </p>
        </div>

        <form onSubmit={handleJoin} className="space-y-4">
          <div>
            <label htmlFor="room-code-input" className="block text-sm font-medium text-slate-700">
              Room Code
            </label>
            <input
              id="room-code-input"
              type="text"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setError(null);
              }}
              placeholder="Enter room code"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base uppercase tracking-wider text-slate-900"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500"
          >
            Join Room
          </button>
        </form>
      </div>
    </main>
  );
}
