'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AccessGate } from '@/components/AccessGate';
import { OpenAnswerFeed } from '@/components/OpenAnswerFeed';
import { PollChart } from '@/components/PollChart';
import { RatingHistogram } from '@/components/RatingHistogram';
import { ApiHttpError, getHrInsights, getRoomSnapshot } from '@/lib/api';
import type { DimensionSummary, HrInsights, RoomSnapshot } from '@/lib/types';

interface DimensionCardProps {
  title: string;
  subtitle: string;
  accentClass: string;
  summary: DimensionSummary;
}

/** Renders a post-session HR dimension card summarizing ratings, poll findings, and anonymized quotes. */
function DimensionCard({ title, subtitle, accentClass, summary }: DimensionCardProps) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-3">
      <div>
        <span className={`inline-block rounded px-2.5 py-0.5 text-xs font-bold uppercase ${accentClass}`}>
          {title}
        </span>
        <p className="mt-1 text-xs text-slate-500">{subtitle}</p>
      </div>

      <div className="grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-3 text-sm">
        <div>
          <span className="block text-xs text-slate-500">Activities</span>
          <span className="font-bold text-slate-900">{summary.activity_count}</span>
        </div>
        <div>
          <span className="block text-xs text-slate-500">Responses</span>
          <span className="font-bold text-slate-900">{summary.response_count}</span>
        </div>
        <div>
          <span className="block text-xs text-slate-500">Avg Rating</span>
          <span className="font-bold text-slate-900">
            {summary.average_rating !== null && Number.isFinite(summary.average_rating)
              ? `${summary.average_rating.toFixed(1)} / 5`
              : 'N/A'}
          </span>
        </div>
      </div>
    </section>
  );
}

/** Authenticated HR Post-Session Dashboard powered by deterministic PostgreSQL aggregations. */
export default function HrDashboardPage() {
  const params = useParams<{ code: string }>();
  const rawCode = typeof params?.code === 'string' ? params.code : '';
  const code = rawCode.trim().toUpperCase();

  const [insights, setInsights] = useState<HrInsights | null>(null);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);

  /** Fetches persisted HR insights and activity metadata from PostgreSQL. */
  const loadDashboard = useCallback(async () => {
    if (!code) return;
    try {
      const [ins, snap] = await Promise.all([getHrInsights(code), getRoomSnapshot(code)]);
      setInsights(ins);
      setSnapshot(snap);
      setNotFound(false);
    } catch (err) {
      if (err instanceof ApiHttpError && (err.status === 404 || err.status === 400)) {
        setNotFound(true);
      }
    } finally {
      setLoading(false);
    }
  }, [code]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  const safeResponseRate =
    insights && Number.isFinite(insights.response_rate) ? insights.response_rate : 0;

  return (
    <AccessGate>
      <main className="min-h-screen bg-slate-50 p-6">
        <div className="mx-auto max-w-6xl space-y-6">
          <header className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div>
              <div className="flex items-center gap-2">
                <span className="rounded bg-indigo-50 px-2.5 py-1 font-mono text-xs font-bold text-indigo-700">
                  {code}
                </span>
                {insights && (
                  <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold uppercase text-slate-700">
                    {insights.session.status}
                  </span>
                )}
              </div>
              <h1 className="mt-1.5 text-2xl font-bold text-slate-900 break-words">
                {notFound
                  ? 'Session Not Found'
                  : insights?.session.title ?? 'HR Post-Session Insight Dashboard'}
              </h1>
              <p className="text-sm text-slate-600">
                Actionable post-session manager capability & organizational blocker report (anonymized).
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Link
                href="/facilitator"
                className="rounded-lg border border-slate-300 px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                ← Facilitator Console
              </Link>
            </div>
          </header>

          {notFound ? (
            <section className="rounded-xl border border-amber-200 bg-white p-6 shadow-sm">
              <p className="text-sm font-medium text-slate-800">
                Session not found. The requested workshop room code is unknown or invalid.
              </p>
            </section>
          ) : loading && !insights ? (
            <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm text-sm text-slate-600">
              Loading HR insights...
            </section>
          ) : insights ? (
            <>
              <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <span className="text-xs font-semibold uppercase text-slate-500">
                    Participants Joined
                  </span>
                  <p className="mt-1 text-2xl font-bold text-slate-900">
                    {insights.participant_count} participants
                  </p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <span className="text-xs font-semibold uppercase text-slate-500">
                    Overall Response Rate
                  </span>
                  <p className="mt-1 text-2xl font-bold text-indigo-700">
                    {safeResponseRate.toFixed(1)}%
                  </p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <span className="text-xs font-semibold uppercase text-slate-500">
                    Activities Completed
                  </span>
                  <p className="mt-1 text-2xl font-bold text-slate-900">
                    {insights.activities.length}
                  </p>
                </div>
              </section>

              <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                <DimensionCard
                  title="Strengths"
                  subtitle="Capabilities where managers feel confident"
                  accentClass="bg-emerald-100 text-emerald-800"
                  summary={insights.strengths}
                />
                <DimensionCard
                  title="Weaknesses"
                  subtitle="Skills and situations requiring coaching support"
                  accentClass="bg-amber-100 text-amber-800"
                  summary={insights.weaknesses}
                />
                <DimensionCard
                  title="Organizational Blockers"
                  subtitle="Systemic friction holding managers back"
                  accentClass="bg-rose-100 text-rose-800"
                  summary={insights.blockers}
                />
              </div>

              <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-5">
                <h2 className="text-lg font-bold text-slate-900">Per-Activity Breakdown</h2>
                {insights.activities.length === 0 ? (
                  <p className="text-sm text-slate-500">No activities recorded for this session.</p>
                ) : (
                  <div className="space-y-6">
                    {insights.activities.map((tally) => {
                      const actMeta = snapshot?.activities.find((a) => a.id === tally.activity_id);
                      return (
                        <div
                          key={tally.activity_id}
                          className="rounded-lg border border-slate-200 p-4 space-y-3"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="rounded bg-slate-100 px-2.5 py-0.5 text-xs font-semibold uppercase text-slate-700">
                              {tally.dimension} • {tally.kind.replace('_', ' ')}
                            </span>
                            <span className="text-xs font-medium text-slate-600">
                              {tally.response_count} responses
                            </span>
                          </div>
                          <h3 className="text-base font-bold text-slate-900 break-words">
                            {tally.prompt}
                          </h3>
                          {tally.kind === 'poll' && (
                            <PollChart
                              options={
                                actMeta?.options ??
                                tally.poll_counts.map((_, i) => `Option ${i + 1}`)
                              }
                              counts={tally.poll_counts}
                              totalResponses={tally.response_count}
                            />
                          )}
                          {tally.kind === 'rating' && (
                            <RatingHistogram
                              histogram={tally.rating_histogram}
                              mean={tally.rating_mean}
                              totalResponses={tally.response_count}
                            />
                          )}
                          {tally.kind === 'open_answer' && (
                            <OpenAnswerFeed quotes={tally.open_answers} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </>
          ) : null}
        </div>
      </main>
    </AccessGate>
  );
}
