'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { ApiHttpError, getRoomSnapshot, getWsBase, joinSession, submitResponse } from '@/lib/api';
import type { RoomSnapshot, WsServerMessage } from '@/lib/types';

/** Mobile-first accountless participant surface for joining a room and submitting live responses. */
export default function JoinRoomPage() {
  const params = useParams<{ code: string }>();
  const rawCode = typeof params?.code === 'string' ? params.code : '';
  const code = rawCode.trim().toUpperCase();

  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const [loading, setLoading] = useState(true);

  const [nickname, setNickname] = useState('');
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);

  const [selectedChoice, setSelectedChoice] = useState<number | null>(null);
  const [selectedRating, setSelectedRating] = useState<number | null>(null);
  const [textAnswer, setTextAnswer] = useState('');
  const [submitStatus, setSubmitStatus] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const lastActivityIdRef = useRef<string | null>(null);

  /** Loads the latest room snapshot over REST. */
  const refreshSnapshot = useCallback(async () => {
    if (!code) return;
    try {
      const snap = await getRoomSnapshot(code);
      setSnapshot(snap);
      setNotFound(false);
    } catch (err) {
      if (err instanceof ApiHttpError && (err.status === 404 || err.status === 400)) {
        setNotFound(true);
      } else if (err instanceof ApiHttpError && err.status === 503) {
        setRevoked(true);
      }
    } finally {
      setLoading(false);
    }
  }, [code]);

  /** Restores an existing participant session from sessionStorage on initial mount or reload. */
  useEffect(() => {
    let cancelled = false;
    async function initRoom() {
      if (!code) return;
      await refreshSnapshot();
      if (cancelled || typeof window === 'undefined') return;

      try {
        const storedId = window.sessionStorage.getItem(`participant_${code}`);
        const storedNick = window.sessionStorage.getItem(`nickname_${code}`);
        if (
          storedId &&
          storedNick &&
          storedId !== storedNick &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(storedId)
        ) {
          const res = await joinSession(code, storedNick, storedId);
          if (!cancelled) {
            setParticipantId(res.participant_id);
            setNickname(storedNick);
            setSnapshot(res.snapshot);
            window.sessionStorage.setItem(`participant_${code}`, res.participant_id);
          }
        }
      } catch {
        try {
          window.sessionStorage.removeItem(`participant_${code}`);
          window.sessionStorage.removeItem(`nickname_${code}`);
        } catch {
          // Ignore storage cleanup errors
        }
      }
    }
    void initRoom();
    return () => {
      cancelled = true;
    };
  }, [code, refreshSnapshot]);

  /** Connects to the room WebSocket stream and automatically recovers across offline/online drops. */
  useEffect(() => {
    if (!code || notFound || revoked) return;
    let active = true;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (!active) return;
      try {
        ws = new WebSocket(`${getWsBase()}/ws/sessions/${encodeURIComponent(code)}`);
      } catch {
        reconnectTimer = setTimeout(connect, 1500);
        return;
      }

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as WsServerMessage;
          if (msg.type === 'room_snapshot') {
            setSnapshot(msg.snapshot);
          } else if (msg.type === 'participant_count') {
            setSnapshot((prev) => (prev ? { ...prev, participant_count: msg.count } : prev));
          } else if (msg.type === 'activity_tally') {
            setSnapshot((prev) => (prev ? { ...prev, current_tally: msg.tally } : prev));
          } else if (msg.type === 'access_revoked') {
            setRevoked(true);
          }
        } catch {
          // Ignore malformed frame
        }
      };

      ws.onclose = () => {
        if (!active) return;
        reconnectTimer = setTimeout(() => {
          void refreshSnapshot();
          connect();
        }, 1200);
      };
    };

    connect();

    const handleOnline = () => {
      void refreshSnapshot();
      if (ws && ws.readyState !== WebSocket.OPEN) {
        try {
          ws.close();
        } catch {
          // Ignore close error
        }
      }
    };
    window.addEventListener('online', handleOnline);

    return () => {
      active = false;
      window.removeEventListener('online', handleOnline);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        try {
          ws.close();
        } catch {
          // Ignore close error
        }
      }
    };
  }, [code, notFound, revoked, refreshSnapshot]);

  const activeActivity = useMemo(() => {
    if (!snapshot || !snapshot.session.current_activity_id) return null;
    return (
      snapshot.activities.find((a) => a.id === snapshot.session.current_activity_id) ?? null
    );
  }, [snapshot]);

  /** Clears transient input selections when the facilitator advances to a new activity. */
  useEffect(() => {
    const currentId = activeActivity?.id ?? null;
    if (lastActivityIdRef.current !== currentId) {
      lastActivityIdRef.current = currentId;
      setSelectedChoice(null);
      setSelectedRating(null);
      setTextAnswer('');
      setSubmitStatus(null);
      setSubmitError(null);
    }
  }, [activeActivity?.id]);

  /** Handles accountless participant room join with nickname and stores reconnect token in sessionStorage. */
  async function handleJoinRoom(e: React.FormEvent) {
    e.preventDefault();
    setJoinError(null);
    const cleanNick = nickname.trim();
    if (!cleanNick) {
      setJoinError('Please enter a nickname to join.');
      return;
    }
    try {
      const res = await joinSession(code, cleanNick, participantId);
      setParticipantId(res.participant_id);
      setSnapshot(res.snapshot);
      if (typeof window !== 'undefined') {
        window.sessionStorage.setItem(`participant_${code}`, res.participant_id);
        window.sessionStorage.setItem(`nickname_${code}`, cleanNick);
      }
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : 'Unable to join session');
    }
  }

  /** Submits the participant's poll, rating, or open-answer response via REST. */
  async function handleSubmitResponse(e: React.FormEvent) {
    e.preventDefault();
    if (!participantId || !activeActivity) return;
    setSubmitError(null);
    setSubmitStatus(null);

    try {
      if (activeActivity.kind === 'poll') {
        if (selectedChoice === null) {
          setSubmitError('Please select an option.');
          return;
        }
        await submitResponse(code, {
          participant_id: participantId,
          activity_id: activeActivity.id,
          choice_index: selectedChoice,
        });
      } else if (activeActivity.kind === 'rating') {
        if (selectedRating === null) {
          setSubmitError('Please select a rating from 1 to 5.');
          return;
        }
        await submitResponse(code, {
          participant_id: participantId,
          activity_id: activeActivity.id,
          rating_value: selectedRating,
        });
      } else {
        const cleanText = textAnswer.trim();
        if (!cleanText) {
          setSubmitError('Please enter your response.');
          return;
        }
        await submitResponse(code, {
          participant_id: participantId,
          activity_id: activeActivity.id,
          text_value: cleanText,
        });
      }
      setSubmitStatus('Response submitted and recorded — thank you!');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to submit response');
    }
  }

  return (
    <main className="min-h-screen w-full max-w-full overflow-x-hidden bg-slate-50 p-4 flex flex-col items-center">
        <div className="w-full max-w-md space-y-4">
          <header className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-indigo-600">
                Room {code}
              </span>
              {snapshot && (
                <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700 capitalize">
                  {snapshot.session.status}
                </span>
              )}
            </div>
            <h1 className="mt-1 text-lg font-bold text-slate-900 break-words">
              {notFound
                ? 'Session Not Found'
                : snapshot?.session.title ?? 'Workshop Participant Room'}
            </h1>
          </header>

          {revoked ? (
            <section className="rounded-xl border border-red-200 bg-white p-5 shadow-sm">
              <h2 className="text-base font-bold text-red-700">Access Revoked</h2>
              <p className="mt-1 text-sm text-slate-600">
                Demo access has been revoked by the administrator.
              </p>
            </section>
          ) : notFound ? (
            <section className="rounded-xl border border-amber-200 bg-white p-5 shadow-sm">
              <p className="text-sm font-medium text-slate-800">
                Session not found. This room code is unknown or invalid.
              </p>
            </section>
          ) : loading && !snapshot ? (
            <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm text-sm text-slate-600">
              Loading room...
            </section>
          ) : !participantId ? (
            <form
              onSubmit={handleJoinRoom}
              className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-4"
            >
              <div>
                <label htmlFor="nickname-input" className="block text-sm font-medium text-slate-700">
                  Your Nickname
                </label>
                <input
                  id="nickname-input"
                  type="text"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  placeholder="Enter your name or nickname"
                  maxLength={50}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900"
                />
              </div>

              {joinError && <p className="text-sm text-red-600">{joinError}</p>}

              <button
                type="submit"
                className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500"
              >
                Join Workshop
              </button>
            </form>
          ) : snapshot?.session.status === 'lobby' ? (
            <section className="rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm space-y-2">
              <h2 className="text-base font-bold text-slate-900">Lobby — Waiting to Start</h2>
              <p className="text-sm text-slate-600">
                You are in the room as <span className="font-semibold">{nickname}</span>. Waiting for the facilitator to launch the next activity.
              </p>
            </section>
          ) : snapshot?.session.status === 'ended' ? (
            <section className="rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm space-y-2">
              <h2 className="text-base font-bold text-slate-900">Session Ended</h2>
              <p className="text-sm text-slate-600">
                This workshop session is now closed. Thank you for participating!
              </p>
            </section>
          ) : !activeActivity ? (
            <section className="rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
              <p className="text-sm text-slate-600">
                Waiting for the facilitator to select an activity...
              </p>
            </section>
          ) : (
            <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
              <div>
                <span className="inline-block rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 uppercase">
                  {activeActivity.kind.replace('_', ' ')}
                </span>
                <h2 className="mt-2 text-base font-bold text-slate-900 break-words">
                  {activeActivity.prompt}
                </h2>
              </div>

              {!activeActivity.is_open ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-800">
                  Submissions Locked — Responses for this activity are currently closed or paused.
                </div>
              ) : (
                <form onSubmit={handleSubmitResponse} className="space-y-4">
                  {activeActivity.kind === 'poll' && (
                    <div className="space-y-2">
                      {activeActivity.options.map((opt, idx) => (
                        <button
                          key={`${idx}-${opt}`}
                          type="button"
                          onClick={() => setSelectedChoice(idx)}
                          aria-pressed={selectedChoice === idx}
                          className={`w-full rounded-lg border px-3.5 py-2.5 text-left text-sm font-medium transition break-words ${
                            selectedChoice === idx
                              ? 'border-indigo-600 bg-indigo-50 text-indigo-900'
                              : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-50'
                          }`}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  )}

                  {activeActivity.kind === 'rating' && (
                    <div className="grid grid-cols-5 gap-2">
                      {[1, 2, 3, 4, 5].map((score) => (
                        <button
                          key={score}
                          type="button"
                          onClick={() => setSelectedRating(score)}
                          aria-pressed={selectedRating === score}
                          className={`rounded-lg border py-3 text-center text-base font-bold transition ${
                            selectedRating === score
                              ? 'border-indigo-600 bg-indigo-600 text-white'
                              : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-50'
                          }`}
                        >
                          {score}
                        </button>
                      ))}
                    </div>
                  )}

                  {activeActivity.kind === 'open_answer' && (
                    <div>
                      <textarea
                        rows={4}
                        value={textAnswer}
                        onChange={(e) => setTextAnswer(e.target.value)}
                        placeholder="Share your candid response (anonymous)..."
                        maxLength={1000}
                        className="w-full rounded-lg border border-slate-300 p-3 text-sm text-slate-900"
                      />
                    </div>
                  )}

                  {submitError && <p className="text-sm text-red-600">{submitError}</p>}
                  {submitStatus && (
                    <p className="rounded-lg bg-emerald-50 p-2.5 text-sm font-medium text-emerald-800">
                      {submitStatus}
                    </p>
                  )}

                  <button
                    type="submit"
                    className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500"
                  >
                    Submit
                  </button>
                </form>
              )}
            </section>
          )}
        </div>
      </main>
  );
}
