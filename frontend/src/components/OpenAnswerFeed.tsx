import React from 'react';
import type { OpenAnswerQuote } from '@/lib/types';

interface OpenAnswerFeedProps {
  quotes: OpenAnswerQuote[];
}

/** Renders anonymized open-answer responses safely escaped against XSS without participant identity. */
export function OpenAnswerFeed({ quotes }: OpenAnswerFeedProps) {
  if (quotes.length === 0) {
    return <p className="text-sm text-slate-500 italic">No open responses submitted yet.</p>;
  }

  return (
    <ul className="space-y-2.5">
      {quotes.map((q, idx) => (
        <li
          key={`${q.activity_id}-${q.submitted_at}-${idx}`}
          className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800 break-words"
        >
          {q.text}
        </li>
      ))}
    </ul>
  );
}
