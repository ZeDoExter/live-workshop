'use client';

import React, { useEffect, useState } from 'react';
import { fetchAuthStatus, logoutAuth, setActiveSessionToken } from '@/lib/api';
import { authClient } from '@/lib/auth-client';

interface AccessGateProps {
  children: React.ReactNode;
}

/** Gates Facilitator and HR surfaces behind Better Auth login/sign-up while general clients join by Room Code. */
export function AccessGate({ children }: AccessGateProps) {
  const { data: sessionData, isPending } = authClient.useSession();
  const [loading, setLoading] = useState(true);
  const [demoActive, setDemoActive] = useState(true);
  const [backendAuthed, setBackendAuthed] = useState(false);

  const [isSignUp, setIsSignUp] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Synchronizes Better Auth session token and checks backend facilitator authentication status. */
  async function syncStatus() {
    if (sessionData?.session?.token) {
      setActiveSessionToken(sessionData.session.token);
    }
    try {
      const status = await fetchAuthStatus();
      setDemoActive(status.demo_active);
      setBackendAuthed(status.demo_active && status.facilitator_authenticated);
    } catch {
      setBackendAuthed(false);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!isPending) {
      void syncStatus();
    }
  }, [isPending, sessionData?.session?.token]);

  /** Handles Facilitator / HR email+password sign-in or account creation via Better Auth. */
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const cleanEmail = email.trim();
    if (!cleanEmail || !password) {
      setError('Email and password are required.');
      return;
    }

    setSubmitting(true);
    try {
      if (isSignUp) {
        const cleanName = name.trim() || cleanEmail.split('@')[0];
        const res = await authClient.signUp.email({
          name: cleanName,
          email: cleanEmail,
          password,
        });
        if (res.error) {
          setError(res.error.message || 'Sign up failed');
          return;
        }
        if (res.data?.token) {
          setActiveSessionToken(res.data.token);
        }
      } else {
        const res = await authClient.signIn.email({
          email: cleanEmail,
          password,
        });
        if (res.error) {
          setError(res.error.message || 'Invalid email or password');
          return;
        }
        if (res.data?.token) {
          setActiveSessionToken(res.data.token);
        }
      }
      await syncStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setSubmitting(false);
    }
  }

  /** Signs out from Better Auth and clears backend cookies. */
  async function handleSignOut() {
    try {
      await authClient.signOut();
    } catch {
      // Ignore client sign-out error
    }
    try {
      await logoutAuth();
    } catch {
      // Ignore backend logout error
    }
    setBackendAuthed(false);
  }

  if (loading || isPending) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4 text-slate-600">
        Checking session...
      </div>
    );
  }

  if (!demoActive) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
        <div className="w-full max-w-md rounded-xl border border-red-200 bg-white p-6 shadow-sm">
          <h1 className="text-xl font-bold text-red-700">Service Unavailable</h1>
          <p className="mt-2 text-sm text-slate-600">
            This workshop environment has been disabled by the administrator.
          </p>
        </div>
      </div>
    );
  }

  if (backendAuthed || Boolean(sessionData?.user)) {
    return (
      <div>
        <div className="border-b border-slate-200 bg-white px-6 py-2.5 flex items-center justify-between text-xs text-slate-600">
          <span>
            Signed in as{' '}
            <strong className="text-slate-900">
              {sessionData?.user?.name || sessionData?.user?.email || 'Facilitator'}
            </strong>
          </span>
          <button
            type="button"
            onClick={() => void handleSignOut()}
            className="rounded border border-slate-300 px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-50"
          >
            Sign Out
          </button>
        </div>
        {children}
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-5">
        <div>
          <span className="inline-block rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
            Better Auth • Facilitator & HR
          </span>
          <h1 className="mt-2 text-xl font-bold text-slate-900">
            {isSignUp ? 'Create Facilitator Account' : 'Facilitator & HR Sign In'}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Sign in to create workshop rooms, control live activities, and view HR insights. Participants join directly from the home page using a Room Code.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 text-xs font-semibold">
          <button
            type="button"
            onClick={() => {
              setIsSignUp(false);
              setError(null);
            }}
            className={`rounded-md py-2 transition ${
              !isSignUp ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
            }`}
          >
            Sign In
          </button>
          <button
            type="button"
            onClick={() => {
              setIsSignUp(true);
              setError(null);
            }}
            className={`rounded-md py-2 transition ${
              isSignUp ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
            }`}
          >
            Create Account
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {isSignUp && (
            <div>
              <label htmlFor="auth-name" className="block text-sm font-medium text-slate-700">
                Full Name
              </label>
              <input
                id="auth-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Enter your name"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900"
              />
            </div>
          )}

          <div>
            <label htmlFor="auth-email" className="block text-sm font-medium text-slate-700">
              Email
            </label>
            <input
              id="auth-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="facilitator@example.com"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900"
            />
          </div>

          <div>
            <label htmlFor="auth-password" className="block text-sm font-medium text-slate-700">
              Password
            </label>
            <input
              id="auth-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password (min 6 characters)"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
          >
            {submitting
              ? 'Please wait...'
              : isSignUp
                ? 'Create Account & Sign In'
                : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
