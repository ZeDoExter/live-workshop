import React from 'react';

interface PollChartProps {
  options: string[];
  counts: number[];
  totalResponses: number;
}

/** Renders live poll response counts and percentages for facilitator and HR views. */
export function PollChart({ options, counts, totalResponses }: PollChartProps) {
  return (
    <div className="space-y-3">
      {options.map((option, idx) => {
        const count = counts[idx] ?? 0;
        const pct = totalResponses > 0 ? (count / totalResponses) * 100 : 0;
        return (
          <div key={`${idx}-${option}`} className="space-y-1">
            <div className="flex items-center justify-between text-sm font-medium text-slate-800 gap-2">
              <span className="break-words">{option}</span>
              <span className="shrink-0 text-slate-600">
                {count} ({pct.toFixed(1)}%)
              </span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-indigo-600 transition-all duration-200"
                style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
