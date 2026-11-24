'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AccessGate } from '@/components/AccessGate';
import { OpenAnswerFeed } from '@/components/OpenAnswerFeed';
import { PollChart } from '@/components/PollChart';
import { RatingHistogram } from '@/components/RatingHistogram';
import {
  createActivity,
  createSession,
  getRoomSnapshot,
  getWsBase,
  listSessions,
  updateSessionState,
} from '@/lib/api';
import type {
  ActivityKind,
  HrDimension,
  RoomSnapshot,
  SessionSummary,
  WsServerMessage,
} from '@/lib/types';

/** Authenticated Facilitator Console for creating sessions, managing pacing, and viewing live visuals. */
export default function FacilitatorPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);

  const [title, setTitle] = useState('');
  const [clientLabel, setClientLabel] = useState('');
  const [createErr, setCreateErr] = useState<string | null>(null);

  const [actKind, setActKind] = useState<ActivityKind>('poll');
  const [actDimension, setActDimension] = useState<HrDimension>('general');
  const [actPrompt, setActPrompt] = useState('');
  const [actOptions, setActOptions] = useState('Option A, Option B');
  const [actErr, setActErr] = useState<string | null>(null);

  /** Loads the list of sessions from the backend. */
  const loadSessions = useCallback(async () => {
    try {
      const list = await listSessions();
      setSessions(list);
    } catch {
      // Handled by AccessGate or transient error
    }
  }, []);

  /** Loads the live room snapshot for a specific session code. */
  const openSession = useCallback(async (code: string) => {
    setSelectedCode(code);
    try {
      const snap = await getRoomSnapshot(code);
      setSnapshot(snap);
    } catch {
      // Ignore fetch failure
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  /** Subscribes to live WebSocket room updates for the currently selected session. */
  useEffect(() => {
    if (!selectedCode) return;
    let active = true;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (!active) return;
      try {
        ws = new WebSocket(`${getWsBase()}/ws/sessions/${encodeURIComponent(selectedCode)}`);
      } catch {
        timer = setTimeout(connect, 1500);
        return;
      }

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as WsServerMessage;
          if (msg.type === 'room_snapshot') {
            setSnapshot(msg.snapshot);
            void loadSessions();
          } else if (msg.type === 'participant_count') {
            setSnapshot((prev) => (prev ? { ...prev, participant_count: msg.count } : prev));
          } else if (msg.type === 'activity_tally') {
            setSnapshot((prev) => (prev ? { ...prev, current_tally: msg.tally } : prev));
          }
        } catch {
          // Ignore malformed WS message
        }
      };

      ws.onclose = () => {
        if (!active) return;
        timer = setTimeout(connect, 1500);
      };
    };

    connect();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      if (ws) {
        try {
          ws.close();
        } catch {
          // Ignore close error
        }
      }
    };
  }, [selectedCode, loadSessions]);

  /** Creates a new workshop session and immediately opens it in the console. */
  async function handleCreateSession(e: React.FormEvent) {
    e.preventDefault();
    setCreateErr(null);
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setCreateErr('Session title is required.');
      return;
    }
    try {
      const created = await createSession(cleanTitle, clientLabel.trim());
      setTitle('');
      setClientLabel('');
      await loadSessions();
      await openSession(created.code);
    } catch (err) {
      setCreateErr(err instanceof Error ? err.message : 'Failed to create session');
    }
  }

  /** Appends a new activity to the currently active session. */
  async function handleAddActivity(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedCode) return;
    setActErr(null);
    const cleanPrompt = actPrompt.trim();
    if (!cleanPrompt) {
      setActErr('Activity prompt is required.');
      return;
    }
    const parsedOptions =
      actKind === 'poll'
        ? actOptions
            .split(/[,|\n]/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    try {
      await createActivity(selectedCode, {
        kind: actKind,
        dimension: actDimension,
        prompt: cleanPrompt,
        options: parsedOptions,
      });
      setActPrompt('');
      const snap = await getRoomSnapshot(selectedCode);
      setSnapshot(snap);
      await loadSessions();
    } catch (err) {
      setActErr(err instanceof Error ? err.message : 'Failed to add activity');
    }
  }

  /** Updates the session status, current activity, or lock flag. */
  async function handleStatePatch(patch: {
    status?: 'lobby' | 'active' | 'ended';
    current_activity_id?: string | null;
    is_open?: boolean;
  }) {
    if (!selectedCode) return;
    try {
      const snap = await updateSessionState(selectedCode, patch);
      setSnapshot(snap);
      await loadSessions();
    } catch {
      // Ignore state update error
    }
  }

  const activeActivity = useMemo(() => {
    if (!snapshot || !snapshot.session.current_activity_id) return null;
    return (
      snapshot.activities.find((a) => a.id === snapshot.session.current_activity_id) ?? null
    );
  }, [snapshot]);

  const currentTally = snapshot?.current_tally ?? null;

  return (
    <AccessGate>
      <main className="min-h-screen bg-slate-50 p-6">
        <div className="mx-auto max-w-6xl space-y-6">
          <header className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div>
              <h1 className="text-2xl font-bold text-slate-900">
                Live WorkShop — Facilitator Console
              </h1>
              <p className="text-sm text-slate-600">
                Create and pace live manager workshop rooms with real-time WebSocket feedback.
              </p>
            </div>
            <Link
              href="/"
              className="rounded-lg border border-slate-300 px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              ← Landing Page
            </Link>
          </header>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <div className="space-y-6">
              <form
                onSubmit={handleCreateSession}
                className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-4"
              >
                <h2 className="text-base font-bold text-slate-900">Create Workshop Session</h2>
                <div>
                  <label htmlFor="session-title" className="block text-sm font-medium text-slate-700">
                    Workshop Title
                  </label>
                  <input
                    id="session-title"
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Enter workshop title"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900"
                  />
                </div>
                <div>
                  <label htmlFor="client-label" className="block text-sm font-medium text-slate-700">
                    Client / Cohort Label
                  </label>
                  <input
                    id="client-label"
                    type="text"
                    value={clientLabel}
                    onChange={(e) => setClientLabel(e.target.value)}
                    placeholder="Enter client or cohort label"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900"
                  />
                </div>
                {createErr && <p className="text-sm text-red-600">{createErr}</p>}
                <button
                  type="submit"
                  className="w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
                >
                  Create Session
                </button>
              </form>

              <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-3">
                <h2 className="text-base font-bold text-slate-900">Workshop Sessions</h2>
                {sessions.length === 0 ? (
                  <p className="text-sm text-slate-500">No workshop sessions created yet.</p>
                ) : (
                  <ul className="space-y-2.5">
                    {sessions.map((s) => (
                      <li
                        key={s.id}
                        className={`rounded-lg border p-3 transition ${
                          selectedCode === s.code
                            ? 'border-indigo-600 bg-indigo-50/40'
                            : 'border-slate-200 bg-white'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-xs font-bold text-indigo-700">
                            {s.code}
                          </span>
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 capitalize">
                            {s.status}
                          </span>
                        </div>
                        <p className="mt-1 text-sm font-semibold text-slate-900 break-words">
                          {s.title}
                        </p>
                        <div className="mt-2 flex items-center justify-between gap-2 text-xs text-slate-500">
                          <span>{s.participant_count} participants</span>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => void openSession(s.code)}
                              className="rounded bg-slate-900 px-2.5 py-1 font-semibold text-white hover:bg-slate-800"
                            >
                              Open
                            </button>
                            <Link
                              href={`/dashboard/${s.code}`}
                              className="rounded border border-slate-300 px-2 py-1 font-medium text-slate-700 hover:bg-slate-50"
                            >
                              HR Insights
                            </Link>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <div className="lg:col-span-2 space-y-6">
              {!snapshot ? (
                <section className="rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
                  <p className="text-sm text-slate-600">
                    Select or create a workshop session to manage activities and view live room responses.
                  </p>
                </section>
              ) : (
                <>
                  <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="rounded bg-indigo-50 px-2.5 py-1 font-mono text-sm font-bold text-indigo-700">
                            {snapshot.session.code}
                          </span>
                          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase text-slate-700">
                            {snapshot.session.status}
                          </span>
                        </div>
                        <h2 className="mt-2 text-xl font-bold text-slate-900 break-words">
                          {snapshot.session.title}
                        </h2>
                        {snapshot.session.client_label && (
                          <p className="text-sm text-slate-500">{snapshot.session.client_label}</p>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-3 text-sm">
                        <div className="rounded-lg bg-slate-50 px-3 py-2 font-semibold text-slate-800">
                          {snapshot.participant_count} participants joined
                        </div>
                        <div className="rounded-lg bg-indigo-50 px-3 py-2 font-semibold text-indigo-800">
                          {currentTally?.response_count ?? 0} / {snapshot.participant_count} responses
                        </div>
                        <Link
                          href={`/dashboard/${snapshot.session.code}`}
                          className="rounded-lg border border-indigo-200 bg-white px-3 py-2 font-semibold text-indigo-700 hover:bg-indigo-50"
                        >
                          HR Dashboard →
                        </Link>
                      </div>
                    </div>

                    {snapshot.session.status !== 'ended' && (
                      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
                        {snapshot.session.status === 'lobby' && (
                          <button
                            type="button"
                            onClick={() =>
                              void handleStatePatch({
                                status: 'active',
                                current_activity_id:
                                  snapshot.session.current_activity_id ??
                                  snapshot.activities[0]?.id ??
                                  null,
                              })
                            }
                            className="rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-500"
                          >
                            Start Live Session
                          </button>
                        )}

                        {activeActivity && (
                          <button
                            type="button"
                            onClick={() =>
                              void handleStatePatch({ is_open: !activeActivity.is_open })
                            }
                            className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                          >
                            {activeActivity.is_open ? 'Lock Submissions' : 'Unlock Submissions'}
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => void handleStatePatch({ status: 'ended' })}
                          className="rounded-lg bg-rose-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-rose-500"
                        >
                          End Session
                        </button>
                      </div>
                    )}
                  </section>

                  <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-base font-bold text-slate-900">Live Room Visuals</h3>
                      {activeActivity && (
                        <span className="rounded bg-slate-100 px-2.5 py-1 text-xs font-semibold uppercase text-slate-700">
                          {activeActivity.dimension} • {activeActivity.kind.replace('_', ' ')}
                        </span>
                      )}
                    </div>

                    {!activeActivity ? (
                      <p className="text-sm text-slate-500">
                        No active activity selected. Activate an activity below to broadcast it to participants.
                      </p>
                    ) : (
                      <div className="space-y-4">
                        <p className="text-base font-semibold text-slate-900 break-words">
                          {activeActivity.prompt}
                        </p>
                        {activeActivity.kind === 'poll' && (
                          <PollChart
                            options={activeActivity.options}
                            counts={currentTally?.poll_counts ?? []}
                            totalResponses={currentTally?.response_count ?? 0}
                          />
                        )}
                        {activeActivity.kind === 'rating' && (
                          <RatingHistogram
                            histogram={currentTally?.rating_histogram ?? [0, 0, 0, 0, 0]}
                            mean={currentTally?.rating_mean ?? null}
                            totalResponses={currentTally?.response_count ?? 0}
                          />
                        )}
                        {activeActivity.kind === 'open_answer' && (
                          <OpenAnswerFeed quotes={currentTally?.open_answers ?? []} />
                        )}
                      </div>
                    )}
                  </section>

                  <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
                    <h3 className="text-base font-bold text-slate-900">Workshop Agenda</h3>
                    {snapshot.activities.length === 0 ? (
                      <p className="text-sm text-slate-500">No activities configured yet.</p>
                    ) : (
                      <ul className="space-y-2.5">
                        {snapshot.activities.map((act) => {
                          const isCurrent = snapshot.session.current_activity_id === act.id;
                          return (
                            <li
                              key={act.id}
                              className={`rounded-lg border p-3.5 ${
                                isCurrent
                                  ? 'border-indigo-600 bg-indigo-50/30'
                                  : 'border-slate-200 bg-white'
                              }`}
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex items-center gap-2 text-xs font-semibold uppercase text-slate-600">
                                  <span>#{act.position}</span>
                                  <span>•</span>
                                  <span>{act.kind.replace('_', ' ')}</span>
                                  <span>•</span>
                                  <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-800">
                                    {act.dimension}
                                  </span>
                                  {!act.is_open && (
                                    <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-800">
                                      Locked
                                    </span>
                                  )}
                                </div>
                                {snapshot.session.status !== 'ended' && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void handleStatePatch({
                                        status: 'active',
                                        current_activity_id: act.id,
                                      })
                                    }
                                    className="rounded bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-indigo-500"
                                  >
                                    {isCurrent ? 'Active' : 'Launch'}
                                  </button>
                                )}
                              </div>
                              <p className="mt-1.5 text-sm font-semibold text-slate-900 break-words">
                                {act.prompt}
                              </p>
                              {act.options.length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  {act.options.map((opt, idx) => (
                                    <span
                                      key={`${idx}-${opt}`}
                                      className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
                                    >
                                      {opt}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}

                    {snapshot.session.status !== 'ended' && (
                      <form
                        onSubmit={handleAddActivity}
                        className="border-t border-slate-200 pt-4 space-y-3"
                      >
                        <h4 className="text-sm font-bold text-slate-900">Add Activity</h4>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <div>
                            <label className="block text-xs font-medium text-slate-700">
                              Activity Kind
                            </label>
                            <select
                              value={actKind}
                              onChange={(e) => setActKind(e.target.value as ActivityKind)}
                              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900"
                            >
                              <option value="poll">Quick Poll</option>
                              <option value="rating">Rating (1-5)</option>
                              <option value="open_answer">Open Answer</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-700">
                              HR Insight Dimension
                            </label>
                            <select
                              value={actDimension}
                              onChange={(e) => setActDimension(e.target.value as HrDimension)}
                              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900"
                            >
                              <option value="general">General</option>
                              <option value="strength">Strength</option>
                              <option value="weakness">Weakness</option>
                              <option value="blocker">Organizational Blocker</option>
                            </select>
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-slate-700">Prompt</label>
                          <input
                            type="text"
                            value={actPrompt}
                            onChange={(e) => setActPrompt(e.target.value)}
                            placeholder="Enter activity question or prompt"
                            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900"
                          />
                        </div>
                        {actKind === 'poll' && (
                          <div>
                            <label className="block text-xs font-medium text-slate-700">
                              Poll Options (comma-separated)
                            </label>
                            <input
                              type="text"
                              value={actOptions}
                              onChange={(e) => setActOptions(e.target.value)}
                              placeholder="Option 1, Option 2, Option 3"
                              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900"
                            />
                          </div>
                        )}
                        {actErr && <p className="text-sm text-red-600">{actErr}</p>}
                        <button
                          type="submit"
                          className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                        >
                          Add Activity
                        </button>
                      </form>
                    )}
                  </section>
                </>
              )}
            </div>
          </div>
        </div>
      </main>
    </AccessGate>
  );
}
